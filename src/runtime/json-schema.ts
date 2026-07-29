import { Ajv, type ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { SchemaLike } from '../types.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export type LocalJsonSchema = Readonly<Record<string, unknown>>;

export interface JsonSchemaLike extends SchemaLike {
  readonly jsonSchema: LocalJsonSchema;
}

function issuePath(error: ErrorObject): PropertyKey[] {
  if (!error.instancePath) return [];
  return error.instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function createJsonSchemaLike(
  jsonSchema: LocalJsonSchema,
): JsonSchemaLike {
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
    useDefaults: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(jsonSchema);

  return {
    jsonSchema,
    safeParse(value) {
      const candidate = structuredClone(value);
      if (validate(candidate)) {
        return { success: true, data: candidate };
      }
      return {
        success: false,
        error: {
          issues: (validate.errors ?? []).map((error) => ({
            path: issuePath(error),
            message: error.message ?? error.keyword,
          })),
        },
      };
    },
  };
}
