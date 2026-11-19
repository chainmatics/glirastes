import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import type { ToolPolicyDefaults } from '../../contracts/tool-policy.js';
import { compareCodeUnits } from './canonical.js';
import type { EndpointMethod } from '../../types.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import { deriveDefinitionId } from './identity.js';
import {
  resolveLayered,
  resolveLayeredEntry,
  textLayer,
  type LocalizedText,
  type TextLayer,
} from '../../contracts/localized-text.js';
import {
  isAgenticSemantics,
  isMaintainedField,
  LocalizedPresentationSchema,
  SEMANTICS_LANGUAGES,
  SemanticsEntrySchema,
  type PresentationLabels,
  type ToolSemanticsEntry,
} from './semantics.js';
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

/**
 * The names a schema issue path may show: entry fields, the languages and the
 * members of an example call and of the agent block. Any other segment is a
 * key of `origin` or `locked` taken from the file, which an agent controls.
 */
const SCHEMA_PATH_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SemanticsEntrySchema.shape),
  ...SEMANTICS_LANGUAGES,
  'sentence', 'input', 'model', 'interfaceDigest',
]);

/** The first issue path with schema names and array indices only; file-controlled keys become `<key>`. */
function schemaIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => typeof segment === 'number' || (typeof segment === 'string' && SCHEMA_PATH_NAMES.has(segment))
      ? String(segment)
      : '<key>')
    .join('.');
}

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
      const path = entry.success ? '' : schemaIssuePath(entry.error.issues[0]?.path ?? []);
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

interface ResourceInput {
  definitionId: string;
  method?: string;
  path?: string;
  hints?: ToolProseHints;
}

/**
 * The resource an endpoint's name stands for: the part before the first dot.
 * Only where the source says so (`hints.resourceFromRoute`, the openapi
 * source), a name without a dot (`list_tags` from `x-glirastes-name`) carries
 * its verb, so the resource comes from method and path as for a derived name.
 * The id alone never decides: a contract id such as `listTags` of another
 * source keeps naming its own module and label.
 */
function endpointResource(input: ResourceInput): string {
  const { definitionId, method, path } = input;
  if (input.hints?.resourceFromRoute === true && !definitionId.includes('.') && method && path) {
    return deriveDefinitionId({ method: method as EndpointMethod, path }).split('.')[0]!;
  }
  return definitionId.split('.')[0] ?? definitionId;
}

/** The resource of an endpoint tool; everything after `ui.` for a UI tool. */
function resourceWords(input: ResourceInput, operation: Operation): string {
  const resource = operation === 'ui'
    ? input.definitionId.split('.').slice(1).join(' ')
    : endpointResource(input);
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

type Labels = PresentationLabels;

function safeLabels(labels: Labels): boolean {
  return !findSensitiveStringPath(labels);
}

/** A presentation as a text layer: one locale, or labels per language tag (secret-looking texts left out). */
function presentationLayer(value: unknown): TextLayer<Labels> | undefined {
  const single = presentationOf(value);
  if (single) {
    const { locale, ...labels } = single;
    return safeLabels(labels) ? { byLanguage: { [locale]: labels } } : undefined;
  }
  const map = LocalizedPresentationSchema.safeParse(value);
  if (!map.success) return undefined;
  const byLanguage = Object.fromEntries(Object.entries(map.data).filter(([, labels]) => safeLabels(labels)));
  return Object.keys(byLanguage).length > 0 ? { byLanguage } : undefined;
}

function labelsOf(text: string): Labels {
  const label = clamp(text, MAX_LABEL);
  return { singular: label, plural: label, approval: label };
}

/** A text layer whose texts are bounded and free of secrets; undefined when none is left. */
function boundedLayer<T>(value: LocalizedText | undefined, max: number, map: (text: string) => T): TextLayer<T> | undefined {
  const layer = textLayer(value);
  if (!layer) return undefined;
  const anyText = bounded(layer.any, max);
  const byLanguage = Object.fromEntries(Object.entries(layer.byLanguage ?? {})
    .map(([language, text]) => [language, bounded(text, max)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([language, text]) => [language, map(text)] as const));
  if (anyText === undefined && Object.keys(byLanguage).length === 0) return undefined;
  return {
    ...(anyText !== undefined ? { any: map(anyText) } : {}),
    ...(Object.keys(byLanguage).length > 0 ? { byLanguage } : {}),
  };
}

const descriptionLayer = (value: LocalizedText | undefined) => boundedLayer(value, MAX_DESCRIPTION, (text) => text);
/** A title (one text, or per language) as labels: the same text for one call, several and the approval. */
const titleLayer = (value: LocalizedText | undefined) => boundedLayer(value, MAX_LABEL, labelsOf);

function sameLabels(left: Labels, right: Labels): boolean {
  return left.singular === right.singular && left.plural === right.plural && left.approval === right.approval;
}

export interface ToolProse {
  /** The one description the model gets (see `MODEL_LANGUAGE`). */
  description: string;
  descriptionOrigin: DescriptionOrigin;
  module: string;
  sharedWith: string[];
  usageHints: string[];
  /** The labels in the app's locale, for the setup artifact. */
  presentation: ToolPresentation;
  /** Labels per language of tools.json `languages`; absent without it. Local only. */
  labels?: Record<string, Labels>;
  /** Languages of `languages` without an own label (they show a fallback). */
  missingLabelLanguages?: string[];
  findings: ToolFinding[];
}

export interface ResolveToolProseInput {
  stableKey: string;
  definitionId: string;
  method?: string;
  path?: string;
  operationGroup: ToolPolicyDefaults['operationGroup'];
  locale: string;
  /** tools.json `languages`: with it, labels are resolved per language and titles become labels. */
  languages?: ReadonlyArray<string>;
  jsDoc?: string;
  hints?: ToolProseHints;
  semantics: ToolSemantics;
  /** The entry the pipeline already checked; `null` when it was rejected. Looked up when absent. */
  entry?: ToolSemanticsEntry | null;
  policyDescription?: string;
}

/**
 * The model gets one description in one language, whatever the user writes:
 * English, as the describing skill asks for, else the fallback order.
 */
export const MODEL_LANGUAGE = 'en';

/** The semantics entry of a tool: by stable key first, then by definition id. */
export function lookupSemantics(
  semantics: ToolSemantics,
  stableKey: string,
  definitionId: string,
): ToolSemanticsEntry | undefined {
  return semantics.byStableKey.get(stableKey) ?? semantics.byName.get(definitionId);
}

function overrideFinding(stableKey: string, field: string): ToolFinding {
  return toolFinding('semantics-overrides-code', 'warning', stableKey,
    `The ${field} in tool-semantics.json differs from the code's and is used: a maintained semantics entry beats the code since 0.18.0.`);
}

/** The template labels speak these languages; labels per language always cover them. */
export const TEMPLATE_LABEL_LANGUAGES = ['de', 'en'] as const;

/**
 * The languages a tool's people-facing texts are declared in: the tags of
 * its presentations and titles (code and tool-semantics.json). Language-free
 * texts name none.
 */
export function declaredLabelLanguages(hints: ToolProseHints | undefined, entry: ToolSemanticsEntry | undefined): string[] {
  const layers = [
    presentationLayer(entry?.presentation),
    titleLayer(entry?.title),
    presentationLayer(hints?.presentations ?? hints?.presentation),
    presentationLayer(hints?.presentation),
    titleLayer(hints?.title),
    titleLayer(hints?.contractTitle),
  ];
  return layers.flatMap((layer) => Object.keys(layer?.byLanguage ?? {}));
}

/**
 * Prose without a model; templates are the visible floor, never a blocker.
 *
 * Precedence of every text, highest first: tool-policy.json, a maintained
 * tool-semantics.json field (human or locked), the code (the endpoint's
 * declared texts, JSDoc or the OpenAPI description, contract.ts, the
 * schema), an agent or code-copied semantics field, the template. Per
 * language: a layer without the language (and without a language-free
 * text) lets the next one speak for it. The module stays a code decision.
 */
export function resolveToolProse(input: ResolveToolProseInput): ToolProse {
  const entry = input.entry === undefined
    ? lookupSemantics(input.semantics, input.stableKey, input.definitionId)
    : input.entry ?? undefined;
  const entryOrigin: DescriptionOrigin = entry?.origin?.description === 'agent'
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
  const language = input.locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const operation = operationOf(input.operationGroup, input.path);
  const words = resourceWords(input, operation);
  const label = labelOf(language, operation, words);
  const findings: ToolFinding[] = [];

  // Description: one text, in one language, for the model.
  const maintainedDescription = isMaintainedField(entry, 'description');
  const semanticsDescription = descriptionLayer(entry?.description);
  const codeDescriptions = [
    descriptionLayer(input.hints?.declaredDescription),
    descriptionLayer(input.jsDoc),
    descriptionLayer(input.hints?.contractDescription),
    descriptionLayer(input.hints?.schemaDescription),
  ];
  const descriptionLayers: ReadonlyArray<readonly [TextLayer<string> | undefined, DescriptionOrigin]> = [
    [descriptionLayer(input.policyDescription), 'human'],
    [maintainedDescription ? semanticsDescription : undefined, entryOrigin],
    ...codeDescriptions.map((layer) => [layer, 'code'] as const),
    [maintainedDescription ? undefined : semanticsDescription, entryOrigin],
  ];
  const chosen = resolveLayeredEntry(descriptionLayers.map(([layer]) => layer), MODEL_LANGUAGE);
  let description: string;
  let descriptionOrigin: DescriptionOrigin = 'template';
  if (chosen) {
    description = chosen.value;
    descriptionOrigin = descriptionLayers[chosen.layer]![1];
    if (chosen.layer === 1) {
      const code = resolveLayered(codeDescriptions, MODEL_LANGUAGE);
      if (code !== undefined && code !== description) findings.push(overrideFinding(input.stableKey, 'description'));
    }
  } else {
    description = clamp(input.method && input.path ? `${label} (${input.method} ${input.path}).` : `${label}.`, MAX_DESCRIPTION);
    findings.push(toolFinding('description-templated', 'warning', input.stableKey,
      'Only a template description is available; the model may pick this tool less reliably.'));
  }
  // Highest first: a code hint (OpenAPI x-glirastes-group, a contract module), tool-semantics.json, the name.
  // A module groups tools; it is no text people read, so the code keeps deciding it.
  const module = identifier(input.hints?.module)
    ?? identifier(entry?.module)
    ?? (endpointResource(input) || 'tools');
  const sharedWith = [...new Set((entry?.sharedWith ?? [])
    .map(identifier)
    .filter((value): value is string => value !== undefined && value !== module))]
    .sort(compareCodeUnits)
    .slice(0, 50);
  // Usage hints and the approval hint each by their own origin, then joined (code hints replace both, as before,
  // unless a maintained field of the entry beats them).
  const codeHints = input.hints?.usageHints?.length ? input.hints.usageHints : undefined;
  const entryUsage = entry?.usageHints?.length ? entry.usageHints : undefined;
  const maintainedUsage = entryUsage !== undefined && isMaintainedField(entry, 'usageHints');
  const maintainedApproval = entry?.approvalHint !== undefined && isMaintainedField(entry, 'approvalHint');
  const usagePart = (maintainedUsage ? entryUsage : codeHints ?? entryUsage) ?? [];
  const approvalPart = entry?.approvalHint && (maintainedApproval || !codeHints) ? [entry.approvalHint] : [];
  const joinedHints = [...usagePart, ...approvalPart];
  if ((maintainedUsage || maintainedApproval) && codeHints && codeHints.join('\n') !== joinedHints.join('\n')) {
    findings.push(overrideFinding(input.stableKey, 'usageHints'));
  }
  const hintSource = joinedHints.length > 0 ? joinedHints : [description];
  const usageHints = hintSource
    .map((hint) => bounded(hint, MAX_HINT))
    .filter((hint): hint is string => hint !== undefined)
    .slice(0, 20);

  // Labels people read: the presentation, a title (with tools.json languages only), the template.
  const withTitles = (input.languages?.length ?? 0) > 0;
  const semanticsPresentation = presentationLayer(entry?.presentation);
  const maintainedPresentation = isMaintainedField(entry, 'presentation');
  // A source may give both: one locale (the artifact as before) and every language it knows (with languages).
  const codePresentation = withTitles
    ? presentationLayer(input.hints?.presentations ?? input.hints?.presentation)
    : presentationLayer(input.hints?.presentation ?? input.hints?.presentations);
  const semanticsTitle = withTitles ? titleLayer(entry?.title) : undefined;
  const maintainedTitle = isMaintainedField(entry, 'title');
  const templateLayer: TextLayer<Labels> = withTitles
    ? { byLanguage: { en: labelsOf(labelOf('en', operation, words)), de: labelsOf(labelOf('de', operation, words)) } }
    : { any: labelsOf(label) };
  const declaredLabels: ReadonlyArray<TextLayer<Labels> | undefined> = [
    maintainedPresentation ? semanticsPresentation : undefined,
    maintainedTitle ? semanticsTitle : undefined,
    codePresentation,
    withTitles ? titleLayer(input.hints?.title) : undefined,
    withTitles ? titleLayer(input.hints?.contractTitle) : undefined,
    maintainedPresentation ? undefined : semanticsPresentation,
    maintainedTitle ? undefined : semanticsTitle,
  ];
  if (maintainedPresentation && semanticsPresentation && codePresentation) {
    const own = resolveLayered([semanticsPresentation], input.locale);
    const code = resolveLayered([codePresentation], input.locale);
    if (own && code && !sameLabels(own, code)) findings.push(overrideFinding(input.stableKey, 'presentation'));
  }
  let presentation: ToolPresentation;
  let labels: Record<string, Labels> | undefined;
  const missingLabelLanguages: string[] = [];
  if (!withTitles) {
    // As before tools.json languages: the first declared presentation, whatever its locale, else the template.
    // A presentation per language gives the app's locale (or its fallback).
    const declared = resolveLayeredEntry([declaredLabels.find((layer) => layer !== undefined)], input.locale);
    presentation = declared?.language !== undefined
      ? { locale: declared.language, ...declared.value }
      : { locale: input.locale, ...labelsOf(label) };
  } else {
    const layers = [...declaredLabels, templateLayer];
    const forLocale = resolveLayeredEntry(layers, input.locale);
    const tag = forLocale?.level === 'request' || forLocale?.language === undefined ? input.locale : forLocale.language;
    presentation = { locale: tag, ...(forLocale?.value ?? labelsOf(label)) };
    labels = {};
    for (const wanted of input.languages!) {
      const found = resolveLayeredEntry(layers, wanted);
      if (found) labels[wanted] = found.value;
      // The template speaks English and German; any other language needs a declaration of its own.
      if (found?.level !== 'request') missingLabelLanguages.push(wanted);
    }
  }
  return {
    description,
    descriptionOrigin,
    module,
    sharedWith,
    usageHints: usageHints.length > 0 ? usageHints : [description.slice(0, MAX_HINT)],
    presentation,
    ...(labels ? { labels } : {}),
    ...(missingLabelLanguages.length > 0 ? { missingLabelLanguages } : {}),
    findings,
  };
}
