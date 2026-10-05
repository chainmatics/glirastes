import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { HandlerConventions } from './handler-analysis.js';
import type { ToolFinding } from './types.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export const MAX_RESOLUTION_SCHEMA_BYTES = 32 * 1024;

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

/** P05 extends entries (model, digests, prose); unknown fields pass through untouched. */
export const ResolutionEntrySchema = z.object({
  origin: z.enum(['human', 'agent']).default('human'),
  interfaceDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  input: SchemaSpecSchema.optional(),
  output: SchemaSpecSchema.optional(),
  effect: z.enum(['read', 'write', 'destructive', 'external', 'financial']).optional(),
}).passthrough();

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

function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, ...rest } = schema;
  return rest;
}

function compilesStrictly(schema: Record<string, unknown>): boolean {
  const ajv = new Ajv({ strict: true, allErrors: false, logger: false });
  addFormats(ajv);
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

function normalizeSpec<T extends { jsonSchema?: Record<string, unknown> }>(spec: T | undefined): T | undefined {
  return spec?.jsonSchema ? { ...spec, jsonSchema: withoutMetaSchema(spec.jsonSchema) } : spec;
}

/** Basic gate for one entry; invalid entries are ignored and the tool keeps its fallback. */
export function validateResolutionEntry(input: {
  stableKey: string;
  raw: unknown;
  evidence: ResolutionEvidence;
}): { entry?: ResolutionEntry; findings: ToolFinding[] } {
  const reject = (reason: string) => ({
    findings: [rejected(input.stableKey, `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const parsed = ResolutionEntrySchema.safeParse(input.raw);
  if (!parsed.success) return reject('it does not match the entry schema');
  if (findSensitiveStringPath(parsed.data)) return reject('it contains secret-looking content');
  const entry = parsed.data;
  const specs = [['input', entry.input], ['output', entry.output]] as const;
  for (const [label, spec] of specs) {
    if (!spec?.jsonSchema) continue;
    const schema = withoutMetaSchema(spec.jsonSchema);
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_RESOLUTION_SCHEMA_BYTES) {
      return reject(`the ${label} schema exceeds 32 KB`);
    }
    if (!compilesStrictly(schema)) return reject(`the ${label} schema is not valid strict JSON Schema`);
    if (label !== 'input') continue;
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      return reject('the input schema must be an object with additionalProperties false');
    }
    // Pattern-matched keys admit names the evidence check below never sees.
    if (schema.patternProperties !== undefined) return reject('input schemas may not use patternProperties');
    if (input.evidence.bodyKeys !== 'opaque') {
      const allowed = new Set([...input.evidence.pathParams, ...input.evidence.queryKeys, ...input.evidence.bodyKeys]);
      const keys = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
      const unbacked = keys.filter((key) => !allowed.has(key)).sort(compareCodeUnits);
      if (unbacked.length > 0) return reject(`input keys without code evidence: ${unbacked.join(', ')}`);
    }
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
