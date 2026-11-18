import { z } from 'zod';
import { ToolPresentationSchema } from '../../contracts/index.js';
import { LANGUAGE_TAG_PATTERN, MAX_TEXT_LANGUAGES, primaryLanguage } from '../../contracts/localized-text.js';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import { AGENT_MODEL_PATTERN, agenticContentProblem, lockDigest } from './agentic.js';
import { compareCodeUnits } from './canonical.js';
import { toolFinding } from './findings.js';
import type { JsonSchemaLike, ToolFinding, ToolTitle } from './types.js';

/**
 * The languages the managed enrichment job fills by default (spec 4.7
 * "DE/EN"). An entry may carry any BCP-47 language tag; tools.json
 * `languages` names the ones an app needs.
 */
export const SEMANTICS_LANGUAGES = ['de', 'en'] as const;
export type SemanticsLanguage = typeof SEMANTICS_LANGUAGES[number];

/** Fields of a `tool-semantics.json` entry that carry an origin and can be locked. */
export const SEMANTICS_FIELDS = [
  'description',
  'title',
  'module',
  'sharedWith',
  'usageHints',
  'presentation',
  'synonyms',
  'examples',
  'exampleCalls',
  'approvalHint',
] as const;
export type SemanticsField = typeof SEMANTICS_FIELDS[number];

export const SEMANTICS_LIMITS = {
  description: 1_000,
  title: 200,
  hint: 500,
  hints: 20,
  synonym: 100,
  synonyms: 20,
  example: 200,
  examplesMin: 3,
  examplesMax: 5,
  exampleCalls: 10,
  approvalHint: 500,
  sharedWith: 50,
} as const;

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/;
const text = (max: number) => z.string().trim().min(1).max(max);
const languageTag = z.string().regex(LANGUAGE_TAG_PATTERN).max(35);
/** One value per BCP-47 language tag (`de`, `pl-PL`); at most MAX_TEXT_LANGUAGES of them. */
const perLanguage = <T extends z.ZodType>(item: T) => z.record(languageTag, item)
  .refine((value) => Object.keys(value).length <= MAX_TEXT_LANGUAGES, { message: `At most ${MAX_TEXT_LANGUAGES} languages` });
/** The labels of one language; `presentation` maps a language tag to them. */
export const PresentationLabelsSchema = z.object({
  singular: z.string().trim().min(1).max(200),
  plural: z.string().trim().min(1).max(200),
  approval: z.string().trim().min(1).max(500),
}).strict();
export type PresentationLabels = z.infer<typeof PresentationLabelsSchema>;
/** `presentation` per language: `{ "de": { singular, plural, approval }, "pl": { … } }`. */
export const LocalizedPresentationSchema = perLanguage(PresentationLabelsSchema)
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one language' });
export type LocalizedPresentation = z.infer<typeof LocalizedPresentationSchema>;

/**
 * One entry of `.glirastes/tool-semantics.json` (spec 4.3, 4.7): the Get It
 * Done format (`name`, `modelName`, `description`, `module`, `sharedWith`,
 * `usageHints`, `presentation`) plus the stage-2 fields. A field without an
 * origin was written by a human; `locked` pins reviewed fields by digest;
 * `agent` names who wrote the agent fields and for which interface.
 */
export const SemanticsEntrySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stableKey: z.string().trim().min(1).max(2_100).optional(),
  /** Written by older exports; read for compatibility, never used. */
  modelName: z.string().optional(),
  /** One text for the model, or one per language (the model gets one; see resolveToolProse). */
  description: z.union([z.string(), perLanguage(z.string())]).optional(),
  module: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
  usageHints: z.array(z.string()).optional(),
  presentation: z.unknown().optional(),
  title: perLanguage(text(SEMANTICS_LIMITS.title)).optional(),
  synonyms: perLanguage(z.array(text(SEMANTICS_LIMITS.synonym)).max(SEMANTICS_LIMITS.synonyms)).optional(),
  examples: perLanguage(z.array(text(SEMANTICS_LIMITS.example))
    .min(SEMANTICS_LIMITS.examplesMin).max(SEMANTICS_LIMITS.examplesMax)).optional(),
  exampleCalls: z.array(z.object({
    sentence: text(SEMANTICS_LIMITS.example).optional(),
    input: z.record(z.string(), z.unknown()),
  }).strict()).max(SEMANTICS_LIMITS.exampleCalls).optional(),
  approvalHint: text(SEMANTICS_LIMITS.approvalHint).optional(),
  origin: z.partialRecord(z.enum(SEMANTICS_FIELDS), z.enum(['human', 'code', 'agent'])).optional(),
  locked: z.partialRecord(z.enum(SEMANTICS_FIELDS), digest).optional(),
  agent: z.object({
    model: z.string().regex(AGENT_MODEL_PATTERN),
    interfaceDigest: digest,
  }).strict().optional(),
}).strict();

export type ToolSemanticsEntry = z.infer<typeof SemanticsEntrySchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an agent wrote the entry or one of its fields; such entries get the unified check. */
export function isAgenticSemantics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.agent !== undefined) return true;
  return isRecord(value.origin) && Object.values(value.origin).includes('agent');
}

/**
 * The languages the texts people read need: tools.json `languages` when the
 * app names them, else the app's language plus English (German or English
 * only, as before `languages` existed), each once.
 */
export function requiredLanguages(locale: string, languages?: ReadonlyArray<string>): string[] {
  if (languages && languages.length > 0) return [...new Set(languages)];
  const own = primaryLanguage(locale);
  return own === 'de' ? ['de', 'en'] : ['en'];
}

export interface SemanticsCheckContext {
  stableKey: string;
  /** Interface the tool has now; an agent entry for another one is stale. */
  interfaceDigest?: string;
  /** The tool's input JSON Schema; example calls must satisfy it. */
  input?: JsonSchemaLike;
}

export interface SemanticsCheck {
  entry?: ToolSemanticsEntry;
  findings: ToolFinding[];
  /** An agent entry written for an earlier interface: still used, listed for renewal. */
  stale: boolean;
  /** Example calls of a stale entry the current input schema refuses; left out of `entry`. */
  droppedExampleCalls?: number;
}

function fieldValue(entry: ToolSemanticsEntry, field: SemanticsField): unknown {
  return entry[field];
}

function proseOf(entry: ToolSemanticsEntry): unknown {
  return {
    description: entry.description,
    title: entry.title,
    usageHints: entry.usageHints,
    synonyms: entry.synonyms,
    examples: entry.examples,
    approvalHint: entry.approvalHint,
    presentation: entry.presentation,
    sentences: entry.exampleCalls?.map((call) => call.sentence),
  };
}

function agentLimitsProblem(entry: ToolSemanticsEntry): string | undefined {
  const descriptions = typeof entry.description === 'object' ? Object.values(entry.description) : [entry.description];
  if (descriptions.some((text) => text !== undefined && text.length > SEMANTICS_LIMITS.description)) {
    return `the description is longer than ${SEMANTICS_LIMITS.description} characters`;
  }
  const hints = entry.usageHints ?? [];
  if (hints.length > SEMANTICS_LIMITS.hints || hints.some((hint) => hint.length > SEMANTICS_LIMITS.hint)) {
    return `usageHints hold at most ${SEMANTICS_LIMITS.hints} hints of ${SEMANTICS_LIMITS.hint} characters`;
  }
  const identifiers = [...(entry.module === undefined ? [] : [entry.module]), ...(entry.sharedWith ?? [])];
  if ((entry.sharedWith?.length ?? 0) > SEMANTICS_LIMITS.sharedWith || identifiers.some((name) => !IDENTIFIER.test(name))) {
    return 'module and sharedWith must be module names (letters, digits, _, . or -)';
  }
  if (entry.presentation !== undefined && !ToolPresentationSchema.safeParse(entry.presentation).success
    && !LocalizedPresentationSchema.safeParse(entry.presentation).success) {
    return 'the presentation does not match its schema (locale, singular, plural, approval; or those three per language tag)';
  }
  return undefined;
}

/**
 * The unified check of one semantics entry against the tool it describes
 * (spec 4.6, 4.7). Locked fields must still match their digest and never be
 * marked as agent output. No entry may carry secrets, provider keys or
 * control characters: `origin` is the writer's own claim, and synonyms reach
 * the generated module. An agent entry must also name its model and
 * interface, stay within the prose and length limits and give example calls
 * that the tool's input schema accepts. A rejected entry is ignored and
 * reported. An agent entry for an earlier interface stays in use and is
 * listed for renewal; its example calls were written for the old schema, so
 * the ones the current schema refuses are left out instead of rejecting it.
 */
export function validateSemanticsEntry(entry: ToolSemanticsEntry, context: SemanticsCheckContext): SemanticsCheck {
  const agentic = isAgenticSemantics(entry);
  const reject = (reason: string): SemanticsCheck => ({
    findings: [toolFinding(agentic || entry.locked ? 'resolution-rejected' : 'tool-semantics-invalid', 'warning',
      context.stableKey, `The tool-semantics.json entry was rejected: ${reason}.`)],
    stale: false,
  });
  for (const field of SEMANTICS_FIELDS) {
    const pinned = entry.locked?.[field];
    if (pinned === undefined) continue;
    if (entry.origin?.[field] === 'agent') return reject(`the locked field ${field} is marked as agent output`);
    if (lockDigest(fieldValue(entry, field) ?? null) !== pinned) {
      return reject(`the locked field ${field} was changed after review; restore it from git, or review it and run glirastes tools verify`);
    }
  }
  const content = agenticContentProblem({
    prose: proseOf(entry), module: entry.module, sharedWith: entry.sharedWith, calls: entry.exampleCalls?.map((call) => call.input),
  });
  if (content) return reject(`it contains ${content}`);
  if (agentic) {
    if (!entry.agent) return reject('an agent entry names its model and the interfaceDigest it was written for (agent.model, agent.interfaceDigest)');
    const business = agenticContentProblem(proseOf(entry), { prose: true });
    if (business) return reject(`it contains ${business}`);
    const limits = agentLimitsProblem(entry);
    if (limits) return reject(limits);
  }
  const stale = entry.agent !== undefined && context.interfaceDigest !== undefined
    && entry.agent.interfaceDigest !== context.interfaceDigest;
  const calls = entry.exampleCalls ?? [];
  if (calls.length === 0) return { entry, findings: [], stale };
  const schema = context.input ? createJsonSchemaLike(context.input) : undefined;
  const accepted = (call: typeof calls[number]) => schema?.safeParse(call.input).success === true;
  if (stale) {
    const kept = calls.filter(accepted);
    return kept.length === calls.length
      ? { entry, findings: [], stale }
      : { entry: { ...entry, exampleCalls: kept }, findings: [], stale, droppedExampleCalls: calls.length - kept.length };
  }
  if (!schema) return reject('example calls need a tool with an input contract');
  const index = calls.findIndex((call) => !accepted(call));
  if (index >= 0) return reject(`example call ${index + 1} does not match the input schema`);
  return { entry, findings: [], stale };
}

export interface SemanticsFacts {
  /** Fields a human wrote, the code supplied or a review locked; an agent never replaces them. */
  protectedFields: SemanticsField[];
  hasSynonyms: boolean;
  /** Required languages without 3–5 example sentences. */
  missingExamples: string[];
}

export function semanticsFacts(
  entry: ToolSemanticsEntry | undefined,
  languages: ReadonlyArray<string>,
): SemanticsFacts {
  const protectedFields = entry
    ? SEMANTICS_FIELDS.filter((field) => fieldValue(entry, field) !== undefined
      && (entry.locked?.[field] !== undefined || entry.origin?.[field] !== 'agent'))
    : [];
  return {
    protectedFields,
    hasSynonyms: Object.values(entry?.synonyms ?? {}).some((list) => list.length > 0),
    missingExamples: languages.filter((language) => (entry?.examples?.[language]?.length ?? 0) === 0),
  };
}

/** Lists per language tag; the tool search reads all of them. */
export type PerLanguageLists = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * A semantics field a person maintains: written by a human (no origin, or
 * `human`) or locked by a review. Such a field beats the code's own text;
 * an unlocked field an agent wrote, or one copied from the code (`code`),
 * stays below the code, where every semantics field was before 0.18.0.
 */
export function isMaintainedField(entry: ToolSemanticsEntry | undefined, field: SemanticsField): boolean {
  if (!entry || entry[field] === undefined) return false;
  if (entry.locked?.[field] !== undefined) return true;
  const origin = entry.origin?.[field];
  return origin === undefined || origin === 'human';
}

/** Per language, the list of the first layer (highest first) that has one. */
export function mergePerLanguage(...layers: ReadonlyArray<PerLanguageLists | undefined>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const layer of layers) {
    for (const [language, list] of Object.entries(layer ?? {})) {
      const taken = Object.keys(merged).some((key) => key.toLowerCase() === language.toLowerCase());
      if (!taken && list.length > 0) merged[language] = [...list];
    }
  }
  return merged;
}

/** A maintained entry field before the endpoint's declaration, the endpoint's before an agent's. */
function ordered<T>(entry: ToolSemanticsEntry | undefined, field: SemanticsField, own: T | undefined, declared: T | undefined): Array<T | undefined> {
  return isMaintainedField(entry, field) ? [own, declared] : [declared, own];
}

/**
 * Synonyms and example sentences of every language, each once, in code-unit
 * order: the search must find a tool in a language its texts lack, so all
 * languages are indexed; none of them is ever sent to the model.
 */
export function semanticsSearch(
  entry: ToolSemanticsEntry | undefined,
  declared?: { synonyms?: PerLanguageLists; examples?: PerLanguageLists },
): { synonyms: string[]; examples: string[] } {
  const collect = (values: ReadonlyArray<string>) => [...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort(compareCodeUnits);
  const synonyms = mergePerLanguage(...ordered(entry, 'synonyms', entry?.synonyms, declared?.synonyms));
  const examples = mergePerLanguage(...ordered(entry, 'examples', entry?.examples, declared?.examples));
  return {
    synonyms: collect(Object.values(synonyms).flat()).slice(0, SEMANTICS_LIMITS.synonyms),
    examples: collect(Object.values(examples).flat()),
  };
}

function titleText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length <= SEMANTICS_LIMITS.title && !/[\u0000-\u001F]/.test(text) ? text : undefined;
}

/**
 * The title per language for the chat's commands and entity actions: a
 * maintained entry before the endpoint's own title, that before an agent's,
 * per language. A language-free endpoint title stands for each of
 * `languages` the others lack. A text the chat list cannot show is left out.
 */
export function semanticsTitle(
  entry: ToolSemanticsEntry | undefined,
  declared?: string | Readonly<Record<string, string>>,
  languages: ReadonlyArray<string> = [],
  /** A lower code title (contract.ts below the OpenAPI operation). */
  lowerDeclared?: string | Readonly<Record<string, string>>,
): ToolTitle | undefined {
  const title: Record<string, string> = {};
  const add = (language: string, value: string | undefined) => {
    const text = titleText(value);
    const taken = Object.keys(title).some((key) => key.toLowerCase() === language.toLowerCase());
    if (text && !taken) title[language] = text;
  };
  // In precedence order; a language-free title fills, at its own level, every language still open.
  const code = [declared, lowerDeclared];
  const layers = isMaintainedField(entry, 'title') ? [entry?.title, ...code] : [...code, entry?.title];
  for (const layer of layers) {
    if (typeof layer === 'string') for (const language of languages) add(language, layer);
    else for (const [language, value] of Object.entries(layer ?? {})) add(language, value);
  }
  return Object.keys(title).length > 0 ? title as ToolTitle : undefined;
}
