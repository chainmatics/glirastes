import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import type { ToolPolicyDefaults } from '../../contracts/tool-policy.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import { isAgenticSemantics, SemanticsEntrySchema, type ToolSemanticsEntry } from './semantics.js';
import type { ToolFinding, ToolProseHints } from './types.js';

export type { ToolSemanticsEntry } from './semantics.js';

export type DescriptionOrigin = 'human' | 'code' | 'agent' | 'template';

const MAX_DESCRIPTION = 1_000;
const MAX_HINT = 500;
const MAX_LABEL = 200;

const SemanticsFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.array(z.unknown()).max(5_000),
}).passthrough();

export interface ToolSemantics {
  byStableKey: ReadonlyMap<string, ToolSemanticsEntry>;
  byName: ReadonlyMap<string, ToolSemanticsEntry>;
}

export const EMPTY_SEMANTICS: ToolSemantics = { byStableKey: new Map(), byName: new Map() };

export function loadToolSemantics(root: string): { semantics: ToolSemantics; findings: ToolFinding[] } {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.semantics), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { semantics: EMPTY_SEMANTICS, findings: [] };
    throw error;
  }
  const invalid = (message: string) => ({
    semantics: EMPTY_SEMANTICS,
    findings: [toolFinding('tool-semantics-invalid', 'warning', TOOLS_PATHS.semantics, message)],
  });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid('tool-semantics.json is not valid JSON and is ignored.');
  }
  const file = SemanticsFileSchema.safeParse(json);
  if (!file.success) return invalid('tool-semantics.json does not match its schema and is ignored.');
  const byStableKey = new Map<string, ToolSemanticsEntry>();
  const byName = new Map<string, ToolSemanticsEntry>();
  const findings: ToolFinding[] = [];
  file.data.tools.forEach((value, index) => {
    const entry = SemanticsEntrySchema.safeParse(value);
    if (!entry.success || (!entry.data.stableKey && !entry.data.name)) {
      // An agent entry that does not even parse is a rejected agentic entry (spec 4.6).
      const agentic = isAgenticSemantics(value);
      const path = entry.success ? '' : entry.error.issues[0]?.path.map(String).join('.') ?? '';
      findings.push(toolFinding(agentic ? 'resolution-rejected' : 'tool-semantics-invalid', 'warning', `${TOOLS_PATHS.semantics}#${index}`,
        `Entry ${index} of tool-semantics.json is invalid${path ? ` at ${path}` : ''} and is ignored.`));
      return;
    }
    if (entry.data.stableKey) byStableKey.set(entry.data.stableKey, entry.data);
    if (entry.data.name) byName.set(entry.data.name, entry.data);
  });
  return { semantics: { byStableKey, byName }, findings };
}

/** Cut to at most `max` UTF-16 units, the unit the schema bounds count, without splitting a surrogate pair. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, Math.max(0, end)).trimEnd();
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || findSensitiveStringPath(text)) return undefined;
  return clamp(text, max);
}

function identifier(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length <= 200 ? text : undefined;
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The resource of an endpoint tool; everything after `ui.` for a UI tool. */
function resourceWords(definitionId: string, operation: Operation): string {
  const resource = operation === 'ui'
    ? definitionId.split('.').slice(1).join(' ')
    : definitionId.split('.')[0] ?? definitionId;
  return resource
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim() || 'item';
}

type Operation = 'list' | 'get' | 'create' | 'update' | 'delete' | 'ui';

const LABELS: Readonly<Record<'en' | 'de', Readonly<Record<Operation, (words: string) => string>>>> = {
  en: {
    list: (words) => `List ${words}`,
    get: (words) => `Show ${words}`,
    create: (words) => `Create ${words}`,
    update: (words) => `Update ${words}`,
    delete: (words) => `Delete ${words}`,
    ui: (words) => `Run ${words}`,
  },
  de: {
    list: (words) => `${capitalized(words)} auflisten`,
    get: (words) => `${capitalized(words)} anzeigen`,
    create: (words) => `${capitalized(words)} anlegen`,
    update: (words) => `${capitalized(words)} ändern`,
    delete: (words) => `${capitalized(words)} löschen`,
    ui: (words) => `${capitalized(words)} ausführen`,
  },
};

/** The verb stays intact: only the resource words give way when the label would exceed the presentation bound. */
function labelOf(language: 'en' | 'de', operation: Operation, words: string): string {
  const build = LABELS[language][operation];
  return clamp(build(clamp(words, MAX_LABEL - build('').length)), MAX_LABEL);
}

function operationOf(group: ToolPolicyDefaults['operationGroup'], path: string | undefined): Operation {
  if (group === 'read') return path && /\/:[^/]+$/.test(path) ? 'get' : 'list';
  return group;
}

function presentationOf(value: unknown): ToolPresentation | undefined {
  const parsed = ToolPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface ToolProse {
  description: string;
  descriptionOrigin: DescriptionOrigin;
  module: string;
  sharedWith: string[];
  usageHints: string[];
  presentation: ToolPresentation;
  findings: ToolFinding[];
}

export interface ResolveToolProseInput {
  stableKey: string;
  definitionId: string;
  method?: string;
  path?: string;
  operationGroup: ToolPolicyDefaults['operationGroup'];
  locale: string;
  jsDoc?: string;
  hints?: ToolProseHints;
  semantics: ToolSemantics;
  /** The entry the pipeline already checked; `null` when it was rejected. Looked up when absent. */
  entry?: ToolSemanticsEntry | null;
  policyDescription?: string;
}

/** The semantics entry of a tool: by stable key first, then by definition id. */
export function lookupSemantics(
  semantics: ToolSemantics,
  stableKey: string,
  definitionId: string,
): ToolSemanticsEntry | undefined {
  return semantics.byStableKey.get(stableKey) ?? semantics.byName.get(definitionId);
}

/** Prose without a model; templates are the visible floor, never a blocker. */
export function resolveToolProse(input: ResolveToolProseInput): ToolProse {
  const entry = input.entry === undefined
    ? lookupSemantics(input.semantics, input.stableKey, input.definitionId)
    : input.entry ?? undefined;
  const entryOrigin: DescriptionOrigin = entry?.origin?.description === 'agent'
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
  const language = input.locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const operation = operationOf(input.operationGroup, input.path);
  const label = labelOf(language, operation, resourceWords(input.definitionId, operation));
  const candidates: ReadonlyArray<readonly [string | undefined, DescriptionOrigin]> = [
    [input.policyDescription, 'human'],
    [input.jsDoc, 'code'],
    [input.hints?.contractDescription, 'code'],
    [input.hints?.schemaDescription, 'code'],
    [entry?.description, entryOrigin],
  ];
  const findings: ToolFinding[] = [];
  let description: string | undefined;
  let descriptionOrigin: DescriptionOrigin = 'template';
  for (const [value, origin] of candidates) {
    const text = bounded(value, MAX_DESCRIPTION);
    if (text) {
      description = text;
      descriptionOrigin = origin;
      break;
    }
  }
  if (!description) {
    description = clamp(input.method && input.path ? `${label} (${input.method} ${input.path}).` : `${label}.`, MAX_DESCRIPTION);
    findings.push(toolFinding('description-templated', 'warning', input.stableKey,
      'Only a template description is available; the model may pick this tool less reliably.'));
  }
  const module = identifier(input.hints?.module)
    ?? identifier(entry?.module)
    ?? (input.definitionId.split('.')[0] || 'tools');
  const sharedWith = [...new Set((entry?.sharedWith ?? [])
    .map(identifier)
    .filter((value): value is string => value !== undefined && value !== module))]
    .sort(compareCodeUnits)
    .slice(0, 50);
  const hintSource = input.hints?.usageHints?.length
    ? input.hints.usageHints
    : entry?.usageHints?.length || entry?.approvalHint
      ? [...entry.usageHints ?? [], ...entry.approvalHint ? [entry.approvalHint] : []]
      : [description];
  const usageHints = hintSource
    .map((hint) => bounded(hint, MAX_HINT))
    .filter((hint): hint is string => hint !== undefined)
    .slice(0, 20);
  const presentation = input.hints?.presentation
    ?? presentationOf(entry?.presentation)
    ?? { locale: input.locale, singular: label, plural: label, approval: label };
  return {
    description,
    descriptionOrigin,
    module,
    sharedWith,
    usageHints: usageHints.length > 0 ? usageHints : [description.slice(0, MAX_HINT)],
    presentation,
    findings,
  };
}
