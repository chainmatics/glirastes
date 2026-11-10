import { describe, expect, it } from 'vitest';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';
import {
  canonicalJson,
  compareCodeUnits,
  deterministicUuid,
  jsonSchemaDigest,
  OPAQUE_JSON_SCHEMA,
  sha256Digest,
} from './canonical.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';

describe('canonical helpers', () => {
  it('sorts object keys deeply by code unit and ends with a newline', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], B: true } }))
      .toBe('{\n  "a": {\n    "B": true,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
    expect(['b', 'B', 'a'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
  });

  it('creates stable RFC 4122 version 5 identifiers scoped to app and parts', () => {
    const first = deterministicUuid(APP_ID, ['setup-artifact', 'sha256:x']);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid(APP_ID, ['setup-artifact', 'sha256:x'])).toBe(first);
    expect(deterministicUuid(APP_ID, ['setup-run', 'sha256:x'])).not.toBe(first);
    expect(deterministicUuid('019fb007-0000-7000-8000-0000000000a2', ['setup-artifact', 'sha256:x']))
      .not.toBe(first);
  });

  it('digests text as sha256 base64url', () => {
    expect(sha256Digest('abc')).toBe('sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('digests JSON schemas exactly like a runtime JsonSchemaLike binding', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false };
    expect(jsonSchemaDigest(schema)).toBe(createLocalSchemaDigest(createJsonSchemaLike(schema)));
    expect(jsonSchemaDigest({ additionalProperties: false, properties: { id: { type: 'string' } }, type: 'object' }))
      .toBe(jsonSchemaDigest(schema));
    expect(jsonSchemaDigest(OPAQUE_JSON_SCHEMA)).toBe(createLocalSchemaDigest(createJsonSchemaLike({})));
  });
});
