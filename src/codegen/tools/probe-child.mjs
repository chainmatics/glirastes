// Probe child for glirastes tools: imports app schema modules with a scrubbed
// environment and reports digests and JSON Schemas on a dedicated result
// channel (file descriptor 3), so anything the imported app code prints to
// stdout cannot corrupt the result. Never used by the app runtime and never
// contacts the network on its own.
import { writeSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TEXT = 1_000;
const RESULT_FD = 3;

// Writes the whole payload even when the pipe accepts it in pieces. A pipe
// that is momentarily full (EAGAIN) is retried after a short sleep.
function writeResult(payload) {
  const buffer = Buffer.from(payload, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(RESULT_FD, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error?.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isSchema(value) {
  return value !== null && typeof value === 'object' && typeof value.safeParse === 'function';
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}

function jsonObject(value) {
  try {
    const copy = JSON.parse(JSON.stringify(value));
    return copy !== null && typeof copy === 'object' && !Array.isArray(copy) ? copy : null;
  } catch {
    return null;
  }
}

/** Texts in any language (contract.ts title, synonyms, examples, a description per language); null when none is declared. */
function declaredTexts(entry) {
  const texts = {};
  for (const field of ['title', 'synonyms', 'examples']) {
    if (entry[field] === undefined) continue;
    try {
      texts[field] = JSON.parse(JSON.stringify(entry[field]) ?? 'null');
    } catch {
      texts[field] = null;
    }
  }
  if (entry.description !== null && typeof entry.description === 'object') texts.description = jsonObject(entry.description);
  return Object.keys(texts).length > 0 ? texts : null;
}

async function main() {
  const request = await readRequest();
  register(new URL('./probe-loader.mjs', import.meta.url), {
    data: {
      typescriptUrl: request.typescriptUrl,
      appRoot: request.appRoot,
      tsconfigPath: request.tsconfigPath,
      sdkSourceRoot: request.sdkSourceRoot,
    },
  });
  const { createLocalSchemaDigest } = await import(request.digestModuleUrl);
  const appRequire = createRequire(join(request.appRoot, 'package.json'));
  const loadOptional = async (specifier) => {
    try {
      return await import(pathToFileURL(appRequire.resolve(specifier)).href);
    } catch {
      return undefined;
    }
  };

  const toJson = async (schema, io) => {
    try {
      if (schema._zod) {
        if (typeof schema.toJSONSchema === 'function') {
          return jsonObject(schema.toJSONSchema({ io, unrepresentable: 'any' }));
        }
        const zod = (await loadOptional('zod/v4')) ?? (await loadOptional('zod'));
        const convert = zod?.toJSONSchema ?? zod?.z?.toJSONSchema;
        return typeof convert === 'function' ? jsonObject(convert(schema, { io, unrepresentable: 'any' })) : null;
      }
      if (schema._def) {
        const converter = await loadOptional('zod-to-json-schema');
        const convert = converter?.zodToJsonSchema ?? converter?.default;
        return typeof convert === 'function'
          ? jsonObject(convert(schema, { $refStrategy: 'none', target: 'jsonSchema7' }))
          : null;
      }
    } catch {
      return null;
    }
    return null;
  };

  const describeSchema = async (value, io) => {
    if (!isSchema(value)) return { ok: false, reason: 'not-a-schema' };
    return {
      ok: true,
      kind: 'schema',
      digest: createLocalSchemaDigest(value),
      jsonSchema: await toJson(value, io),
      description: text(value.description) ?? text(value._def?.description),
    };
  };

  // Only an absent field is undeclared: null is an invalid declaration (fail closed), as in OpenAPI and defineTool.
  const fieldList = (value) => {
    if (value === undefined) return null;
    return Array.isArray(value) && value.length <= 200
      && value.every((path) => typeof path === 'string' && path.length <= 200)
      ? [...value]
      : 'invalid';
  };

  const entityList = (value) => {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length > 20) return 'invalid';
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return 'invalid';
    }
  };

  // A declared JSON value goes on (wrapped, so any value is told apart from the marker); anything else is invalid.
  const jsonDeclaration = (value) => {
    if (value === undefined) return null;
    try {
      const text = JSON.stringify(value);
      if (text === undefined || text.length > 64 * 1024) return 'invalid';
      return { value: JSON.parse(text) };
    } catch {
      return 'invalid';
    }
  };

  const describeEntry = async (entry) => {
    if (entry === null || typeof entry !== 'object') return { ok: false, reason: 'invalid-entry' };
    const input = await describeSchema(entry.input, 'input');
    if (!input.ok) return { ok: false, reason: 'invalid-entry' };
    const output = entry.output === undefined ? null : await describeSchema(entry.output, 'output');
    if (output && !output.ok) return { ok: false, reason: 'invalid-entry' };
    return {
      ok: true,
      kind: 'contract-entry',
      input,
      output,
      description: text(entry.description),
      effect: typeof entry.effect === 'string' ? entry.effect : null,
      id: typeof entry.id === 'string' ? entry.id : null,
      module: typeof entry.module === 'string' ? entry.module : null,
      usageHints: Array.isArray(entry.usageHints)
        ? entry.usageHints.filter((hint) => typeof hint === 'string').slice(0, 20)
        : null,
      presentation: entry.presentation !== null && typeof entry.presentation === 'object'
        ? jsonObject(entry.presentation)
        : null,
      texts: declaredTexts(entry),
      // A finite number goes on to the range check; any other declared value is invalid.
      maxResultChars: entry.maxResultChars === undefined || entry.maxResultChars === null
        ? null
        : typeof entry.maxResultChars === 'number' && Number.isFinite(entry.maxResultChars)
          ? entry.maxResultChars
          : 'invalid',
      // A list of at most 200 strings goes on to the path check; any other declared value (null too) is invalid.
      outputAllowedFields: fieldList(entry.outputAllowedFields),
      outputDeniedFields: fieldList(entry.outputDeniedFields),
      outputDefaultFields: fieldList(entry.outputDefaultFields),
      // Checked in the parent; only a list of at most 20 JSON values goes on, anything else declared is invalid.
      outputEntities: entityList(entry.outputEntities),
      inputEntities: entityList(entry.inputEntities),
      // Approval subjects: checked in the parent.
      entityLookup: jsonDeclaration(entry.entityLookup),
      approvalSubject: jsonDeclaration(entry.approvalSubject),
      lookupEffect: jsonDeclaration(entry.lookupEffect),
    };
  };

  const results = [];
  for (const item of request.items) {
    try {
      const module = await import(pathToFileURL(join(request.appRoot, item.module)).href);
      let value = module[item.export];
      for (const key of item.property) value = value === null || value === undefined ? undefined : value[key];
      if (value === undefined || value === null) {
        results.push({ ok: false, reason: 'missing' });
      } else {
        results.push(item.kind === 'contract-entry'
          ? await describeEntry(value)
          : await describeSchema(value, item.io));
      }
    } catch {
      results.push({ ok: false, reason: 'import-failed' });
    }
  }
  return results;
}

main().then(
  (results) => {
    writeResult(JSON.stringify({ results }));
    process.exit(0);
  },
  () => process.exit(1),
);
