import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { canonicalJson, sha256Digest } from './canonical.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/**
 * Shared gate for everything a coding agent or the managed job writes into
 * `tool-resolutions.json` and `tool-semantics.json` (spec 4.6 "Einheitliche
 * Prüfung"). The generator applies it the same way, whoever wrote the entry.
 */

/** Largest JSON Schema one agentic entry may carry. */
export const MAX_AGENTIC_SCHEMA_BYTES = 32 * 1024;

/** A model slug or coding-agent label: `anthropic/claude-sonnet-5.5`, `codex`, `claude-code`. */
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const PROVIDER_KEY_PREFIX = /sk-or-v1/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** Nine or more digits in a row (optionally grouped): phone, IBAN or account numbers. */
const LONG_NUMBER = /\d(?:[ .\-/]?\d){8,}/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Keywords that admit object keys the evidence check never sees. */
const OPEN_KEY_KEYWORDS = ['patternProperties', 'propertyNames'] as const;

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      strings(child, found);
    }
  }
  return found;
}

/**
 * The first content problem of an agentic value, or undefined. Every value is
 * checked for secrets, provider keys (any `sk-or-v1`, also short ones) and
 * control characters; prose (descriptions, hints, synonyms, example sentences)
 * additionally refuses e-mail addresses and long numbers, which only real
 * business data would put there. The reason never repeats the content.
 */
export function agenticContentProblem(value: unknown, options: { prose?: boolean } = {}): string | undefined {
  if (findSensitiveStringPath(value)) return 'secret-looking content';
  const texts = strings(value);
  if (texts.some((text) => PROVIDER_KEY_PREFIX.test(text))) return 'a provider key prefix (sk-or-v1)';
  if (texts.some((text) => CONTROL.test(text))) return 'control characters';
  if (options.prose && texts.some((text) => EMAIL.test(text) || LONG_NUMBER.test(text))) {
    return 'what looks like business data (an e-mail address or a long number)';
  }
  return undefined;
}

/** `$schema` names the dialect only; the generator always compiles JSON Schema 2020-12. */
export function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, ...rest } = schema;
  return rest;
}

function compileProblem(schema: Record<string, unknown>): string | undefined {
  // Zod v4 emits 2020-12 schemas, tuples as `prefixItems` without minItems.
  const ajv = new Ajv2020({ strict: true, strictTuples: false, allErrors: false, logger: false });
  addFormats(ajv);
  try {
    ajv.compile(schema);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid schema';
    return message.length <= 200 ? message : `${message.slice(0, 199)}…`;
  }
}

/**
 * Why a JSON Schema an agent wrote is unusable, or undefined: at most 32 KB,
 * strict JSON Schema 2020-12; an input schema is additionally an object with
 * `additionalProperties: false` and fixed keys only.
 */
export function strictSchemaProblem(
  schema: Record<string, unknown>,
  role: 'input' | 'output',
): string | undefined {
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_AGENTIC_SCHEMA_BYTES) {
    return `the ${role} schema exceeds 32 KB`;
  }
  const compiled = compileProblem(schema);
  if (compiled) return `the ${role} schema is not valid strict JSON Schema (${compiled})`;
  if (role === 'output') return undefined;
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    return 'the input schema must be an object with additionalProperties false';
  }
  const open = OPEN_KEY_KEYWORDS.find((keyword) => schema[keyword] !== undefined);
  if (open) return `input schemas may not use ${open}`;
  return undefined;
}

/** Property names of an object schema, sorted; empty for anything else. */
export function schemaPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties).sort()
    : [];
}

/** Digest of a reviewed value; `glirastes tools verify` writes it, the generator compares it. */
export function lockDigest(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}
