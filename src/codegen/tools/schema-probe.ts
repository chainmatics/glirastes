import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { chatComponentManifestSchema, type ChatComponentManifest } from '../../contracts/chat-view.js';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import type { DeclaredEffect } from '../../contracts/tool-policy.js';
import {
  entityDeclarationIssue,
  inputEntityRefIssue,
  type InputEntityRef,
  type OutputEntityDeclaration,
} from '../../contracts/entity-declaration.js';
import { isValidMaxResultChars } from '../../runtime/result-limit.js';
import { normalizeOutputFields } from '../../server/core/output-fields.js';
import { sha256Digest, sortKeysDeep } from './canonical.js';
import { CODE_FIELD_NAMES, FAIL_CLOSED_SUBJECT, readApprovalDeclarations, type ApprovalDeclarations } from './approval-subject-declarations.js';
import { readDeclaredTexts, type DeclaredTextField, type DeclaredTexts } from './declared-texts.js';
import { LocalizedPresentationSchema, type LocalizedPresentation } from './semantics.js';
import type { JsonSchemaLike } from './types.js';

export interface SchemaProbeItem {
  kind: 'schema' | 'contract-entry' | 'chat-component';
  io: 'input' | 'output';
  module: string;
  export: string;
  property: string[];
}

export interface ProbedSchema {
  ok: true;
  kind: 'schema';
  digest: string;
  jsonSchema: JsonSchemaLike | null;
  description: string | null;
}

/** Contract metadata fields that were declared but are unusable, so they read as `null`. */
export type InvalidContractField =
  | 'effect' | 'presentation' | 'maxResultChars' | 'outputAllowedFields' | 'outputDeniedFields' | 'outputDefaultFields'
  | DeclaredTextField
  | 'outputEntities' | 'inputEntities';

/** The output field declarations of a contract entry. */
const OUTPUT_FIELD_NAMES = ['outputAllowedFields', 'outputDeniedFields', 'outputDefaultFields'] as const;

export interface ProbedContractEntry {
  ok: true;
  kind: 'contract-entry';
  input: ProbedSchema;
  output: ProbedSchema | null;
  description: string | null;
  effect: DeclaredEffect | null;
  id: string | null;
  module: string | null;
  usageHints: string[] | null;
  presentation: ToolPresentation | null;
  /** `presentation` given per language tag instead of one locale. */
  presentations?: LocalizedPresentation;
  /**
   * Texts in any language the entry declares (`title`, `synonyms`,
   * `examples`, a `description` per language). Not part of `moduleDigest`:
   * they describe the tool for people and the search, not the contract.
   */
  texts?: DeclaredTexts['hints'];
  /**
   * `maxResultChars` of the entry, when it is an integer from 1,000 to
   * 200,000. Not part of `moduleDigest`: it bounds results, not the contract.
   */
  maxResultChars?: number;
  /**
   * `outputAllowedFields`, `outputDeniedFields` and `outputDefaultFields` of
   * the entry, when valid (normalized: de-duplicated, sorted). Not part of
   * `moduleDigest`: they shape results; the reduced output schema is part of
   * the contract itself.
   */
  outputAllowedFields?: string[];
  outputDeniedFields?: string[];
  outputDefaultFields?: string[];
  /**
   * `outputEntities` and `inputEntities` of the entry, when every entry is a
   * valid declaration (field names and types only). Not part of
   * `moduleDigest`: they name the identity of results, not the contract.
   */
  outputEntities?: OutputEntityDeclaration[];
  inputEntities?: InputEntityRef[];
  /**
   * `entityLookup`, `approvalSubject` and `lookupEffect` of the entry: the
   * valid ones, and the issues of the others in words without their values
   * (reported by the pipeline as `approval-subject-invalid`, which never
   * disables the tool). Not part of `moduleDigest`.
   */
  approval?: ApprovalDeclarations & { issues?: string[] };
  /**
   * Set only when the entry declares an `effect` outside the known set, a
   * `presentation` that fails its schema, a `maxResultChars` out of range or
   * an output field list that is not a list of valid field paths;
   * names the fields, never their values, so a typo can be told apart from an
   * absent field.
   */
  invalidFields?: InvalidContractField[];
  moduleDigest: string;
}

/**
 * `content-rejected`: the schema, description or contract metadata carries a
 * secret-looking string (content boundary), so nothing of it may be committed.
 */
export type ProbeFailureReason =
  | 'missing' | 'import-failed' | 'not-a-schema' | 'invalid-entry' | 'content-rejected' | 'timeout' | 'probe-failed';

export interface ProbeFailure {
  ok: false;
  reason: ProbeFailureReason;
  /** Why a chat component definition was refused (the SDK's own message); never set for schemas. */
  detail?: string;
}

/** A `defineChatComponent` definition turned into its manifest by the SDK (one entry). */
export interface ProbedChatComponent {
  ok: true;
  kind: 'chat-component';
  manifest: ChatComponentManifest;
}

export type SchemaProbeResult = ProbedSchema | ProbedContractEntry | ProbedChatComponent | ProbeFailure;

export interface SchemaProbeOptions {
  /**
   * Absolute path of the tsconfig whose path aliases the probed modules use
   * (the one of the source's program), or null for none. Omitted: the app
   * root's tsconfig.json, when there is one.
   */
  tsconfig?: string | null;
}

export interface SchemaProbe {
  probe(root: string, items: ReadonlyArray<SchemaProbeItem>, options?: SchemaProbeOptions): Promise<SchemaProbeResult[]>;
}

export const PROBE_TIMEOUT_MS = 10_000;
const CHUNK_SIZE = 25;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const ENVIRONMENT_KEYS = ['PATH', 'NODE_ENV', 'TZ'] as const;
const DECLARED_EFFECTS: ReadonlyArray<string> = ['read', 'write', 'destructive', 'external', 'financial'];

const WireSchema = z.object({
  ok: z.literal(true),
  kind: z.literal('schema'),
  digest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  jsonSchema: z.record(z.string(), z.unknown()).nullable(),
  description: z.string().nullable(),
});
const WireEntry = z.object({
  ok: z.literal(true),
  kind: z.literal('contract-entry'),
  input: WireSchema,
  output: WireSchema.nullable(),
  description: z.string().nullable(),
  effect: z.string().nullable(),
  id: z.string().nullable(),
  module: z.string().nullable(),
  usageHints: z.array(z.string()).nullable(),
  presentation: z.record(z.string(), z.unknown()).nullable(),
  texts: z.record(z.string(), z.unknown()).nullable().optional(),
  maxResultChars: z.union([z.number(), z.literal('invalid')]).nullable().optional(),
  outputAllowedFields: z.union([z.array(z.string()), z.literal('invalid')]).nullable().optional(),
  outputDeniedFields: z.union([z.array(z.string()), z.literal('invalid')]).nullable().optional(),
  outputDefaultFields: z.union([z.array(z.string()), z.literal('invalid')]).nullable().optional(),
  outputEntities: z.union([z.array(z.unknown()), z.literal('invalid')]).nullable().optional(),
  inputEntities: z.union([z.array(z.unknown()), z.literal('invalid')]).nullable().optional(),
  entityLookup: z.union([z.object({ value: z.unknown() }).strict(), z.literal('invalid')]).nullable().optional(),
  approvalSubject: z.union([z.object({ value: z.unknown() }).strict(), z.literal('invalid')]).nullable().optional(),
  lookupEffect: z.union([z.object({ value: z.unknown() }).strict(), z.literal('invalid')]).nullable().optional(),
});
const WireChatComponent = z.object({
  ok: z.literal(true),
  kind: z.literal('chat-component'),
  manifest: chatComponentManifestSchema,
});
const WireFailure = z.object({
  ok: z.literal(false),
  reason: z.enum(['missing', 'import-failed', 'not-a-schema', 'invalid-entry']),
  detail: z.string().optional(),
});
const WireOutput = z.object({ results: z.array(z.union([WireEntry, WireSchema, WireChatComponent, WireFailure])) });

const CONTENT_REJECTED: ProbeFailure = Object.freeze({ ok: false, reason: 'content-rejected' });

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function sdkLocations(): { digestModuleUrl: string; chatViewsModuleUrl: string; sdkSourceRoot: string | null; typescriptUrl: string } {
  const compiled = new URL('../../runtime/local-tool-bindings.js', import.meta.url);
  const fromSource = !existsSync(fileURLToPath(compiled));
  return {
    digestModuleUrl: fromSource
      ? new URL('../../runtime/local-tool-bindings.ts', import.meta.url).href
      : compiled.href,
    chatViewsModuleUrl: new URL(fromSource ? '../../chat-views/define.ts' : '../../chat-views/define.js', import.meta.url).href,
    sdkSourceRoot: fromSource ? fileURLToPath(new URL('../../', import.meta.url)) : null,
    typescriptUrl: pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href,
  };
}

function normalizeJson(value: Record<string, unknown> | null): JsonSchemaLike | null {
  if (!value) return null;
  const { $schema: _metaSchema, ...rest } = value;
  return sortKeysDeep(rest) as JsonSchemaLike;
}

function carriesSecret(value: unknown): boolean {
  return findSensitiveStringPath(value) !== null;
}

function toSchema(wire: z.infer<typeof WireSchema>): ProbedSchema | ProbeFailure {
  const description = wire.description?.trim();
  const schema: ProbedSchema = {
    ok: true,
    kind: 'schema',
    digest: wire.digest,
    jsonSchema: normalizeJson(wire.jsonSchema),
    description: description ? description.slice(0, 1_000) : null,
  };
  return carriesSecret([schema.jsonSchema, schema.description]) ? CONTENT_REJECTED : schema;
}

function toEntry(wire: z.infer<typeof WireEntry>): ProbedContractEntry | ProbeFailure {
  const input = toSchema(wire.input);
  if (!input.ok) return input;
  const output = wire.output ? toSchema(wire.output) : null;
  if (output && !output.ok) return output;
  const presentation = wire.presentation ? ToolPresentationSchema.safeParse(wire.presentation) : undefined;
  // A presentation per language is no presentation of the single-locale schema; read it on its own.
  const presentations = wire.presentation && !presentation?.success
    ? LocalizedPresentationSchema.safeParse(wire.presentation)
    : undefined;
  const rawTexts = wire.texts ?? {};
  const texts = readDeclaredTexts({
    ...(rawTexts.title !== undefined ? { title: rawTexts.title } : {}),
    ...(rawTexts.description !== undefined ? { description: rawTexts.description ?? 'invalid' } : {}),
    ...(rawTexts.synonyms !== undefined ? { synonyms: rawTexts.synonyms } : {}),
    ...(rawTexts.examples !== undefined ? { examples: rawTexts.examples } : {}),
  });
  const metadata = {
    description: wire.description?.trim() ? wire.description.trim().slice(0, 1_000) : null,
    effect: wire.effect && DECLARED_EFFECTS.includes(wire.effect) ? wire.effect as DeclaredEffect : null,
    id: wire.id?.trim() || null,
    module: wire.module?.trim() || null,
    usageHints: wire.usageHints
      ? wire.usageHints.map((hint) => hint.trim()).filter(Boolean).slice(0, 20)
      : null,
    presentation: presentation?.success ? presentation.data : null,
  };
  if (carriesSecret(metadata)) return CONTENT_REJECTED;
  const invalidFields: InvalidContractField[] = [];
  if (wire.effect !== null && metadata.effect === null) invalidFields.push('effect');
  if (presentation && !presentation.success && !presentations?.success) invalidFields.push('presentation');
  for (const field of texts.invalid) invalidFields.push(field);
  const declaredLimit = wire.maxResultChars ?? null;
  const maxResultChars = isValidMaxResultChars(declaredLimit) ? declaredLimit : undefined;
  if (declaredLimit !== null && maxResultChars === undefined) invalidFields.push('maxResultChars');
  const outputFields: Partial<Record<(typeof OUTPUT_FIELD_NAMES)[number], string[]>> = {};
  for (const name of OUTPUT_FIELD_NAMES) {
    const declared = wire[name] ?? null;
    if (declared === null) continue;
    const paths = declared === 'invalid' ? undefined : normalizeOutputFields(declared, name);
    if (paths) outputFields[name] = paths;
    else invalidFields.push(name);
  }
  const entities: { outputEntities?: OutputEntityDeclaration[]; inputEntities?: InputEntityRef[] } = {};
  for (const [name, issueOf] of [
    ['outputEntities', (item: unknown) => entityDeclarationIssue(item, { output: true })],
    ['inputEntities', inputEntityRefIssue],
  ] as const) {
    const declared = wire[name] ?? null;
    if (declared === null) continue;
    if (declared !== 'invalid' && declared.every((item) => issueOf(item) === undefined)) {
      (entities as Record<string, unknown>)[name] = declared;
    } else {
      invalidFields.push(name);
    }
  }
  // Field paths are written to tool-contracts.json: a secret-looking one rejects the entry like any metadata.
  if (carriesSecret(outputFields) || carriesSecret(entities)) return CONTENT_REJECTED;
  // Approval subjects: only valid declarations go on (a secret-looking one is an issue), never an invalid value.
  const approvalIssues: string[] = [];
  const approvalRaw: Record<string, unknown> = {};
  for (const name of ['entityLookup', 'approvalSubject', 'lookupEffect'] as const) {
    const declared = wire[name] ?? null;
    if (declared === null) continue;
    if (declared === 'invalid') approvalIssues.push(`${name} that is not a JSON value of at most 64 KiB`);
    else approvalRaw[name] = declared.value;
  }
  const approvalRead = readApprovalDeclarations(approvalRaw, CODE_FIELD_NAMES);
  approvalIssues.push(...approvalRead.issues);
  // An approvalSubject the probe could not carry (a function, a cycle, too large) is never dropped: it fails closed.
  if (wire.approvalSubject === 'invalid') {
    (approvalRead.declarations as { approvalSubject?: unknown }).approvalSubject = FAIL_CLOSED_SUBJECT;
  }
  const approval = Object.keys(approvalRead.declarations).length > 0 || approvalIssues.length > 0
    ? { ...approvalRead.declarations, ...(approvalIssues.length > 0 ? { issues: approvalIssues } : {}) }
    : undefined;
  return {
    ok: true,
    kind: 'contract-entry',
    input,
    output,
    ...metadata,
    ...(maxResultChars !== undefined ? { maxResultChars } : {}),
    ...outputFields,
    ...(presentations?.success && !carriesSecret(presentations.data) ? { presentations: presentations.data } : {}),
    ...(Object.keys(texts.hints).length > 0 ? { texts: texts.hints } : {}),
    ...entities,
    ...(approval ? { approval } : {}),
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    moduleDigest: sha256Digest(JSON.stringify(sortKeysDeep({
      input: input.digest,
      output: output?.digest ?? null,
      ...metadata,
    }))),
  };
}

function runChunk(
  root: string,
  items: ReadonlyArray<SchemaProbeItem>,
  timeoutMs: number,
  options: SchemaProbeOptions,
): Promise<SchemaProbeResult[]> {
  return new Promise((resolveResults) => {
    let settled = false;
    let output = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (results: SchemaProbeResult[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResults(results);
    };
    const failAll = (reason: ProbeFailureReason) => finish(items.map(() => ({ ok: false, reason })));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./probe-child.mjs', import.meta.url))], {
      cwd: root,
      env: scrubbedEnvironment(),
      shell: false,
      // fd 3 carries the result; stdout stays out of the protocol because the
      // imported app code may print to it at import time.
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      failAll('timeout');
    }, timeoutMs);
    child.on('error', () => failAll('probe-failed'));
    const resultStream = child.stdio[3] as Readable;
    resultStream.setEncoding('utf8');
    resultStream.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        child.kill('SIGKILL');
        failAll('probe-failed');
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        failAll('probe-failed');
        return;
      }
      const parsed = WireOutput.safeParse((() => {
        try {
          return JSON.parse(output) as unknown;
        } catch {
          return undefined;
        }
      })());
      if (!parsed.success || parsed.data.results.length !== items.length) {
        failAll('probe-failed');
        return;
      }
      finish(parsed.data.results.map((result): SchemaProbeResult => {
        if (!result.ok) return { ok: false, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
        if (result.kind === 'chat-component') return carriesSecret(result.manifest) ? CONTENT_REJECTED : result;
        return result.kind === 'contract-entry' ? toEntry(result) : toSchema(result);
      }));
    });
    const requestStream = child.stdin as Writable;
    requestStream.on('error', () => failAll('probe-failed'));
    requestStream.end(JSON.stringify({
      appRoot: root,
      ...(options.tsconfig !== undefined ? { tsconfigPath: options.tsconfig } : {}),
      items,
      ...sdkLocations(),
    }));
  });
}

/**
 * Imports exported schema modules in a child process: environment reduced to
 * PATH/NODE_ENV/TZ, no shell, bounded time and output. A chunk that fails as
 * a whole is retried module by module so one hanging module only costs itself.
 * Results that carry a secret-looking string are rejected per item.
 */
export function createSchemaProbe(options: { timeoutMs?: number; chunkSize?: number } = {}): SchemaProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const chunkSize = Math.max(1, options.chunkSize ?? CHUNK_SIZE);
  return {
    async probe(root, items, probeOptions = {}) {
      const results: SchemaProbeResult[] = [];
      for (let index = 0; index < items.length; index += chunkSize) {
        const chunk = items.slice(index, index + chunkSize);
        const chunkResults = await runChunk(root, chunk, timeoutMs, probeOptions);
        const wholeChunkFailed = chunk.length > 1 && chunkResults.every((result) => (
          !result.ok && (result.reason === 'timeout' || result.reason === 'probe-failed')
        ));
        if (!wholeChunkFailed) {
          results.push(...chunkResults);
          continue;
        }
        for (const item of chunk) results.push(...await runChunk(root, [item], timeoutMs, probeOptions));
      }
      return results;
    },
  };
}
