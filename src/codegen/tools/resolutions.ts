import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { riskTier, type DeclaredEffect } from '../../contracts/tool-policy.js';
import type { ToolRiskClass } from '../../contracts/index.js';
import {
  AGENT_MODEL_PATTERN,
  agenticContentProblem,
  lockDigest,
  MAX_AGENTIC_SCHEMA_BYTES,
  schemaPropertyNames,
  strictSchemaProblem,
  withoutMetaSchema,
} from './agentic.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { HandlerConventions } from './handler-analysis.js';
import type { ToolFinding } from './types.js';

export const MAX_RESOLUTION_SCHEMA_BYTES = MAX_AGENTIC_SCHEMA_BYTES;

const appModule = z.string().trim().min(1).max(512)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'Path must stay inside the app');
const exportName = z.string().trim().min(1).max(200);
const argumentIndex = z.number().int().min(0).max(15);

export const HandlerWrapperConventionSchema = z.object({
  module: appModule,
  export: exportName,
  inputArg: argumentIndex.optional(),
  queryArg: argumentIndex.optional(),
  outputArg: argumentIndex.optional(),
}).strict();

export const ToolConventionsSchema = z.object({
  handlerWrappers: z.array(HandlerWrapperConventionSchema).max(50).default([]),
  bodyReaders: z.array(z.object({ module: appModule, export: exportName }).strict()).max(50).default([]),
  authHelpers: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).max(100).default([]),
  /** Accepted now; used by the filter sources in P04. */
  filterValues: z.record(z.string(), z.array(z.string().max(200)).max(200)).default({}),
}).strict();

export const SchemaRefSchema = z.object({
  module: appModule,
  export: exportName,
  property: z.array(exportName).max(8).default([]),
}).strict();

const SchemaSpecSchema = z.object({
  schemaRef: SchemaRefSchema.optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(
  (spec) => Boolean(spec.schemaRef) !== Boolean(spec.jsonSchema),
  'Provide exactly one of schemaRef or jsonSchema',
);

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);

/**
 * One `tool-resolutions.json` entry (spec 4.3, 4.6): a contract for one
 * stableKey, bound to the handler interface it was written for. Strict: an
 * unknown field rejects the entry. An agent entry names who wrote it
 * (`model`); `glirastes tools verify` turns a reviewed entry into a human one
 * and pins it with `locked`, the digest of the entry without that field.
 */
export const ResolutionEntrySchema = z.object({
  origin: z.enum(['human', 'agent']).default('human'),
  interfaceDigest: digest,
  input: SchemaSpecSchema.optional(),
  output: SchemaSpecSchema.optional(),
  effect: z.enum(['read', 'write', 'destructive', 'external', 'financial']).optional(),
  model: z.string().regex(AGENT_MODEL_PATTERN).optional(),
  locked: digest.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.origin === 'agent' && entry.model === undefined) {
    context.addIssue({ code: 'custom', path: ['model'], message: 'An agent entry names the model or coding agent that wrote it' });
  }
  if (entry.origin === 'agent' && entry.locked !== undefined) {
    context.addIssue({ code: 'custom', path: ['locked'], message: 'A locked entry was reviewed and is no agent entry' });
  }
});

const ResolutionsFileSchema = z.object({
  schemaVersion: z.literal(1),
  conventions: z.unknown().optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ToolConventions = z.infer<typeof ToolConventionsSchema>;
export type ResolutionEntry = z.infer<typeof ResolutionEntrySchema>;

export interface ToolResolutions {
  conventions: ToolConventions;
  entries: ReadonlyMap<string, unknown>;
}

export const EMPTY_CONVENTIONS: ToolConventions = {
  handlerWrappers: [],
  bodyReaders: [],
  authHelpers: [],
  filterValues: {},
};

/** Compile-time proof that parsed conventions satisfy the handler analyzer. */
export function toHandlerConventions(conventions: ToolConventions): HandlerConventions {
  return conventions;
}

function rejected(subjectRef: string, message: string): ToolFinding {
  return toolFinding('resolution-rejected', 'warning', subjectRef, message);
}

export function loadToolResolutions(root: string): { resolutions: ToolResolutions; findings: ToolFinding[] } {
  const empty: ToolResolutions = { conventions: EMPTY_CONVENTIONS, entries: new Map() };
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.resolutions), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { resolutions: empty, findings: [] };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { resolutions: empty, findings: [rejected(TOOLS_PATHS.resolutions, 'tool-resolutions.json is not valid JSON and is ignored.')] };
  }
  const file = ResolutionsFileSchema.safeParse(json);
  if (!file.success) {
    return { resolutions: empty, findings: [rejected(TOOLS_PATHS.resolutions, 'tool-resolutions.json does not match its schema and is ignored.')] };
  }
  const findings: ToolFinding[] = [];
  const conventions = ToolConventionsSchema.safeParse(file.data.conventions ?? {});
  if (!conventions.success) {
    findings.push(rejected('conventions', 'The conventions in tool-resolutions.json are invalid and are ignored.'));
  }
  const entries = new Map(Object.entries(file.data.tools ?? {})
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  return {
    resolutions: { conventions: conventions.success ? conventions.data : EMPTY_CONVENTIONS, entries },
    findings,
  };
}

export interface ResolutionEvidence {
  pathParams: ReadonlyArray<string>;
  queryKeys: ReadonlyArray<string>;
  bodyKeys: ReadonlyArray<string> | 'opaque';
}

const EFFECT_RISK: Readonly<Record<DeclaredEffect, ToolRiskClass>> = {
  read: 'safe-read',
  write: 'write',
  destructive: 'delete',
  external: 'external',
  financial: 'financial',
};

/**
 * Keys an input schema may name and must keep: every name needs code
 * evidence (path, query or a closed body), and no evidenced query or body
 * key may be dropped. An opaque body admits any body key, because the code
 * cannot show which ones the handler passes on.
 */
export function inputEvidenceProblem(
  schema: Record<string, unknown>,
  evidence: ResolutionEvidence,
): string | undefined {
  const keys = schemaPropertyNames(schema);
  if (evidence.bodyKeys !== 'opaque') {
    const allowed = new Set([...evidence.pathParams, ...evidence.queryKeys, ...evidence.bodyKeys]);
    const unbacked = keys.filter((key) => !allowed.has(key));
    if (unbacked.length > 0) return `input keys without code evidence: ${unbacked.join(', ')}`;
  }
  const present = new Set(keys);
  const lost = [...evidence.queryKeys, ...(evidence.bodyKeys === 'opaque' ? [] : evidence.bodyKeys)]
    .filter((key) => !present.has(key))
    .sort(compareCodeUnits);
  if (lost.length > 0) return `the input schema drops parameters the handler reads: ${[...new Set(lost)].join(', ')}`;
  return undefined;
}

/** The digest `glirastes tools verify` pins: the entry as parsed, without `locked`. */
export function resolutionLockDigest(entry: ResolutionEntry): string {
  const { locked: _locked, ...content } = entry;
  return lockDigest(content);
}

function normalizeSpec<T extends { jsonSchema?: Record<string, unknown> }>(spec: T | undefined): T | undefined {
  return spec?.jsonSchema ? { ...spec, jsonSchema: withoutMetaSchema(spec.jsonSchema) } : spec;
}

function firstIssuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path.map(String).join('.') ?? '';
  return path ? ` at ${path}` : '';
}

/**
 * The unified check of one entry (spec 4.6): strict parse, content limits, an
 * intact lock, effects that only raise the risk, strict JSON Schema of at
 * most 32 KB, and input keys that match the code evidence. An invalid entry
 * is ignored with `resolution-rejected`; the tool keeps its fallback.
 */
export function validateResolutionEntry(input: {
  stableKey: string;
  raw: unknown;
  evidence: ResolutionEvidence;
  /** The risk class the code alone derives; an effect below it is refused. */
  codeRiskClass?: ToolRiskClass;
}): { entry?: ResolutionEntry; findings: ToolFinding[] } {
  const reject = (reason: string) => ({
    findings: [rejected(input.stableKey, `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const parsed = ResolutionEntrySchema.safeParse(input.raw);
  if (!parsed.success) return reject(`it does not match the entry schema${firstIssuePath(parsed.error)}`);
  const entry = parsed.data;
  const content = agenticContentProblem(entry);
  if (content) return reject(`it contains ${content}`);
  if (entry.locked !== undefined && resolutionLockDigest(entry) !== entry.locked) {
    return reject('it was changed after review; restore it from git, or review it and run glirastes tools verify');
  }
  if (entry.effect && input.codeRiskClass
    && riskTier(EFFECT_RISK[entry.effect]) < riskTier(input.codeRiskClass)) {
    return reject(`its effect ${entry.effect} would lower the risk below ${input.codeRiskClass}; effects may only raise it`);
  }
  const specs = [['input', entry.input], ['output', entry.output]] as const;
  for (const [role, spec] of specs) {
    if (!spec?.jsonSchema) continue;
    const schema = withoutMetaSchema(spec.jsonSchema);
    const problem = strictSchemaProblem(schema, role);
    if (problem) return reject(problem);
    if (role !== 'input') continue;
    const evidence = inputEvidenceProblem(schema, input.evidence);
    if (evidence) return reject(evidence);
  }
  return {
    entry: {
      ...entry,
      ...(entry.input ? { input: normalizeSpec(entry.input) } : {}),
      ...(entry.output ? { output: normalizeSpec(entry.output) } : {}),
    },
    findings: [],
  };
}

export function resolutionOrigin(resolutions: ToolResolutions, stableKey: string): 'human' | 'agent' | undefined {
  const parsed = ResolutionEntrySchema.safeParse(resolutions.entries.get(stableKey));
  return parsed.success ? parsed.data.origin : undefined;
}
