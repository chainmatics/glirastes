import { TOOLS_PATHS } from '../codegen/tools/config.js';
import type { ToolsPipelineTool } from '../codegen/tools/pipeline.js';
import {
  SEMANTICS_FIELDS,
  SEMANTICS_LANGUAGES,
  SemanticsEntrySchema,
  type SemanticsField,
  type SemanticsLanguage,
} from '../codegen/tools/semantics.js';

/**
 * What the managed job may change, decided before the model runs and applied
 * after it: the model's files are proposals. Entries of tools outside the
 * scope, fields a person wrote or locked and agent fields that are still
 * current always keep the state the job started from.
 */

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const PER_LANGUAGE: ReadonlySet<SemanticsField> = new Set(['title', 'synonyms', 'examples']);
const REJECTION_CODES: ReadonlySet<string> = new Set(['resolution-rejected', 'tool-semantics-invalid']);

export interface ToolWritePolicy {
  interfaceDigest: string;
  /** Semantics fields the job may set: missing ones, and agent ones written for another interface. */
  fields: ReadonlySet<SemanticsField>;
  /** Current agent fields per language (title, synonyms, examples): only these missing languages may be added. */
  languages: ReadonlyMap<SemanticsField, ReadonlyArray<SemanticsLanguage>>;
  /** The job may write the tool's tool-resolutions.json entry. */
  resolution: boolean;
  /** The stored entry does not parse and is ignored today: the job's entry replaces it. */
  replaceSemantics: boolean;
}

export interface WritePolicy {
  tools: ReadonlyMap<string, ToolWritePolicy>;
  /** `conventions` of tool-resolutions.json (an `auth-evidence-missing` item is in scope). */
  conventions: boolean;
}

function parseJson(text: string | null | undefined): JsonRecord | undefined {
  if (text === null || text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function semanticsEntries(file: JsonRecord | undefined): JsonRecord[] {
  return Array.isArray(file?.tools) ? file.tools.filter(isRecord) : [];
}

export function writePolicy(input: {
  tools: ReadonlyArray<ToolsPipelineTool>;
  /** Tools whose semantics the job works. */
  scope: ReadonlySet<string>;
  /** Tools whose tool-resolutions.json entry the job may write (schema gaps, stage-1 items). */
  resolutionScope: ReadonlySet<string>;
  semantics: string | null;
  resolutions: string | null;
  /** Stable keys whose entries the generator rejects today. */
  rejected: ReadonlySet<string>;
  conventions: boolean;
}): WritePolicy {
  const storedSemantics = new Map(semanticsEntries(parseJson(input.semantics))
    .filter((entry) => typeof entry.stableKey === 'string')
    .map((entry) => [entry.stableKey as string, entry] as const));
  const resolutionsFile = parseJson(input.resolutions);
  const storedResolutions = isRecord(resolutionsFile?.tools) ? resolutionsFile.tools : {};
  const tools = new Map<string, ToolWritePolicy>();
  for (const tool of input.tools) {
    const inScope = input.scope.has(tool.stableKey);
    const inResolutionScope = input.resolutionScope.has(tool.stableKey);
    if ((!inScope && !inResolutionScope) || !tool.interfaceDigest) continue;
    const rejected = input.rejected.has(tool.stableKey) || tool.semantics.rejected;
    const fields = new Set<SemanticsField>();
    const languages = new Map<SemanticsField, SemanticsLanguage[]>();
    const raw = storedSemantics.get(tool.stableKey);
    const parsed = raw ? SemanticsEntrySchema.safeParse(raw) : undefined;
    const replaceSemantics = parsed !== undefined && !parsed.success;
    if (inScope) {
      const entry = parsed?.success ? parsed.data : undefined;
      const stale = entry?.agent?.interfaceDigest !== tool.interfaceDigest;
      for (const field of SEMANTICS_FIELDS) {
        if (!entry || replaceSemantics || entry[field] === undefined) {
          fields.add(field);
          continue;
        }
        // A field a person wrote, the code supplies or a review locked is never the job's.
        if (entry.locked?.[field] !== undefined || entry.origin?.[field] !== 'agent') continue;
        if (stale || rejected) fields.add(field);
        else if (PER_LANGUAGE.has(field)) {
          const present = entry[field] as Partial<Record<SemanticsLanguage, unknown>>;
          const missing = SEMANTICS_LANGUAGES.filter((language) => present[language] === undefined);
          if (missing.length > 0) languages.set(field, missing);
        }
      }
    }
    let resolution = false;
    if (inResolutionScope) {
      const stored = storedResolutions[tool.stableKey];
      resolution = stored === undefined || (isRecord(stored) && stored.origin === 'agent' && stored.locked === undefined
        && (stored.interfaceDigest !== tool.interfaceDigest || rejected));
    }
    tools.set(tool.stableKey, { interfaceDigest: tool.interfaceDigest, fields, languages, resolution, replaceSemantics });
  }
  return { tools, conventions: input.conventions };
}

/** Removes a tool's permissions, e.g. after the generator rejected what the job wrote for it. */
export function withoutTools(policy: WritePolicy, keys: ReadonlySet<string>): WritePolicy {
  return { ...policy, tools: new Map([...policy.tools].filter(([key]) => !keys.has(key))) };
}

/** The fields the work list may still offer the model for one tool. */
export function openSemanticsFields(policy: ToolWritePolicy | undefined): SemanticsField[] {
  if (!policy) return [];
  return SEMANTICS_FIELDS.filter((field) => policy.fields.has(field) || policy.languages.has(field));
}

function mergeEntry(stored: JsonRecord, proposed: JsonRecord, policy: ToolWritePolicy, model: string): JsonRecord {
  const result: JsonRecord = policy.replaceSemantics ? { stableKey: stored.stableKey } : structuredClone(stored);
  const origin: JsonRecord = !policy.replaceSemantics && isRecord(stored.origin) ? { ...stored.origin } : {};
  let wrote = false;
  for (const field of SEMANTICS_FIELDS) {
    const next = proposed[field];
    if (next === undefined) continue;
    if (policy.fields.has(field)) {
      if (equal(next, result[field])) continue;
      result[field] = next;
      origin[field] = 'agent';
      wrote = true;
    } else if (policy.languages.has(field) && isRecord(next) && isRecord(result[field])) {
      const current = result[field] as JsonRecord;
      for (const language of policy.languages.get(field)!) {
        if (current[language] !== undefined || next[language] === undefined) continue;
        result[field] = { ...(result[field] as JsonRecord), [language]: next[language] };
        wrote = true;
      }
    }
  }
  if (!wrote) return stored;
  result.origin = origin;
  result.agent = { model, interfaceDigest: policy.interfaceDigest };
  return result;
}

export interface MergeResult {
  /** The file to write; `null` keeps the file absent. */
  text: string | null;
  /** Stable keys (and `conventions`) the merge changed. */
  changed: string[];
}

/**
 * tool-semantics.json as the job may leave it: the stored file, with the
 * model's values only where the policy allows them. Entries are never
 * removed, unknown fields and the model's own `origin`, `agent` and `locked`
 * claims never pass.
 */
export function mergeSemantics(stored: string | null, proposed: string | null, policy: WritePolicy, model: string): MergeResult {
  const storedFile = stored === null ? { schemaVersion: 1, tools: [] } : parseJson(stored);
  // A stored file that does not parse is ignored as a whole; the job does not guess at it.
  if (!storedFile || !Array.isArray(storedFile.tools)) return { text: stored, changed: [] };
  const proposals = new Map(semanticsEntries(parseJson(proposed))
    .filter((entry) => typeof entry.stableKey === 'string')
    .map((entry) => [entry.stableKey as string, entry] as const));
  const changed: string[] = [];
  const seen = new Set<string>();
  const tools = storedFile.tools.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.stableKey !== 'string') return entry;
    const key = entry.stableKey;
    const allowed = policy.tools.get(key);
    const proposal = proposals.get(key);
    if (!allowed || !proposal || seen.has(key)) return entry;
    seen.add(key);
    const merged = mergeEntry(entry, proposal, allowed, model);
    if (merged !== entry) changed.push(key);
    return merged;
  });
  for (const [key, allowed] of policy.tools) {
    const proposal = proposals.get(key);
    if (seen.has(key) || !proposal) continue;
    const merged = mergeEntry({ stableKey: key }, proposal, { ...allowed, replaceSemantics: false }, model);
    if (Object.keys(merged).length === 1) continue;
    tools.push(merged);
    changed.push(key);
  }
  if (changed.length === 0) return { text: stored, changed };
  return { text: `${JSON.stringify({ ...storedFile, schemaVersion: 1, tools }, null, 2)}\n`, changed };
}

/** tool-resolutions.json as the job may leave it: only the entries the policy allows, always as agent entries. */
export function mergeResolutions(stored: string | null, proposed: string | null, policy: WritePolicy, model: string): MergeResult {
  const storedFile = stored === null ? { schemaVersion: 1, tools: {} } : parseJson(stored);
  const proposedFile = parseJson(proposed);
  if (!storedFile || !proposedFile) return { text: stored, changed: [] };
  const storedTools = isRecord(storedFile.tools) ? storedFile.tools : {};
  const proposedTools = isRecord(proposedFile.tools) ? proposedFile.tools : {};
  const tools: JsonRecord = { ...storedTools };
  const changed: string[] = [];
  for (const [key, allowed] of policy.tools) {
    const proposal = proposedTools[key];
    if (!allowed.resolution || !isRecord(proposal) || equal(proposal, storedTools[key])) continue;
    const { locked: _locked, ...entry } = proposal;
    tools[key] = { ...entry, origin: 'agent', model };
    changed.push(key);
  }
  const result: JsonRecord = { ...storedFile, tools };
  if (policy.conventions && proposedFile.conventions !== undefined && !equal(proposedFile.conventions, storedFile.conventions)) {
    result.conventions = proposedFile.conventions;
    changed.push('conventions');
  }
  if (changed.length === 0) return { text: stored, changed };
  return { text: `${JSON.stringify({ schemaVersion: 1, ...result }, null, 2)}\n`, changed };
}

/** Stable keys the generator rejected, from finding subjects (a key, or an index into tool-semantics.json). */
export function rejectedKeys(
  findings: ReadonlyArray<{ code: string; subjectRef: string }>,
  semantics: string | null,
): Set<string> {
  const entries = semanticsEntries(parseJson(semantics));
  const keys = new Set<string>();
  for (const finding of findings) {
    if (!REJECTION_CODES.has(finding.code)) continue;
    const index = finding.subjectRef.startsWith(`${TOOLS_PATHS.semantics}#`)
      ? Number(finding.subjectRef.slice(TOOLS_PATHS.semantics.length + 1))
      : undefined;
    const key = index === undefined ? finding.subjectRef : entries[index]?.stableKey;
    if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

/**
 * Why tool-contracts.json may not be committed: a tool removed or added, or
 * the entry of a tool outside the scope changed. Empty when the change stays
 * inside the scope.
 */
export function contractViolations(stored: string | undefined, generated: string | undefined, scope: ReadonlySet<string>): string[] {
  const before = parseJson(stored);
  const after = parseJson(generated);
  if (!before || !after || !Array.isArray(before.tools) || !Array.isArray(after.tools)) return ['tool-contracts.json is unreadable'];
  const violations: string[] = [];
  const { tools: beforeTools, ...beforeHeader } = before;
  const { tools: afterTools, ...afterHeader } = after;
  if (!equal(beforeHeader, afterHeader)) violations.push('the header of tool-contracts.json changed');
  const keyed = (tools: unknown[]) => new Map(tools.filter(isRecord).map((tool) => [String(tool.stableKey), tool] as const));
  const previous = keyed(beforeTools as unknown[]);
  const next = keyed(afterTools as unknown[]);
  for (const [key, tool] of previous) {
    if (!next.has(key)) violations.push(`removed ${key}`);
    else if (!scope.has(key) && !equal(tool, next.get(key))) violations.push(`changed ${key} outside the scope`);
  }
  for (const key of next.keys()) if (!previous.has(key)) violations.push(`added ${key}`);
  return violations;
}
