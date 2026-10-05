import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import type { DeclaredEffect } from '../../contracts/tool-policy.js';
import { sha256Digest, sortKeysDeep } from './canonical.js';
import type { JsonSchemaLike } from './types.js';

export interface SchemaProbeItem {
  kind: 'schema' | 'contract-entry';
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
}

export type SchemaProbeResult = ProbedSchema | ProbedContractEntry | ProbeFailure;

export interface SchemaProbe {
  probe(root: string, items: ReadonlyArray<SchemaProbeItem>): Promise<SchemaProbeResult[]>;
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
});
const WireFailure = z.object({
  ok: z.literal(false),
  reason: z.enum(['missing', 'import-failed', 'not-a-schema', 'invalid-entry']),
});
const WireOutput = z.object({ results: z.array(z.union([WireEntry, WireSchema, WireFailure])) });

const CONTENT_REJECTED: ProbeFailure = Object.freeze({ ok: false, reason: 'content-rejected' });

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function sdkLocations(): { digestModuleUrl: string; sdkSourceRoot: string | null; typescriptUrl: string } {
  const compiled = new URL('../../runtime/local-tool-bindings.js', import.meta.url);
  const fromSource = !existsSync(fileURLToPath(compiled));
  return {
    digestModuleUrl: fromSource
      ? new URL('../../runtime/local-tool-bindings.ts', import.meta.url).href
      : compiled.href,
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
  return {
    ok: true,
    kind: 'contract-entry',
    input,
    output,
    ...metadata,
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
        if (!result.ok) return { ok: false, reason: result.reason };
        return result.kind === 'contract-entry' ? toEntry(result) : toSchema(result);
      }));
    });
    const requestStream = child.stdin as Writable;
    requestStream.on('error', () => failAll('probe-failed'));
    requestStream.end(JSON.stringify({ appRoot: root, items, ...sdkLocations() }));
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
    async probe(root, items) {
      const results: SchemaProbeResult[] = [];
      for (let index = 0; index < items.length; index += chunkSize) {
        const chunk = items.slice(index, index + chunkSize);
        const chunkResults = await runChunk(root, chunk, timeoutMs);
        const wholeChunkFailed = chunk.length > 1 && chunkResults.every((result) => (
          !result.ok && (result.reason === 'timeout' || result.reason === 'probe-failed')
        ));
        if (!wholeChunkFailed) {
          results.push(...chunkResults);
          continue;
        }
        for (const item of chunk) results.push(...await runChunk(root, [item], timeoutMs));
      }
      return results;
    },
  };
}
