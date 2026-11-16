import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createJsonSchemaLike } from '../runtime/json-schema.js';
import { SDK_ROOT } from './tools/__tests__/app-fixture.js';
import {
  dereference,
  OPENAPI_TOOL_METHODS,
  operationFingerprint,
  operationsOf,
  parseOpenapiDocument,
  type OpenapiDocument,
} from './openapi-document.js';

type Json = Record<string, unknown>;

function parse(document: Json): OpenapiDocument {
  const parsed = parseOpenapiDocument(JSON.stringify(document));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document;
}

/** A 3.0 document whose only component schema is `schema`. */
function normalized(schema: unknown, version = '3.0.3'): unknown {
  const document = parse({ openapi: version, info: {}, paths: {}, components: { schemas: { S: schema } } });
  return (document.components as { schemas: Json }).schemas.S;
}

function fingerprints(document: OpenapiDocument): string[] {
  return operationsOf(document).flatMap((entry) => {
    const method = OPENAPI_TOOL_METHODS[entry.operationKey];
    return method && entry.path ? [operationFingerprint(document, entry, method, entry.path)] : [];
  });
}

describe('parseOpenapiDocument versions', () => {
  it.each(['3.0.0', '3.0.3', '3.1.0', '3.1.1'])('reads OpenAPI %s', (version) => {
    expect(parseOpenapiDocument(JSON.stringify({ openapi: version, paths: {} })).ok).toBe(true);
  });

  it.each([
    [{ swagger: '2.0', paths: {} }, 'is not an OpenAPI document'],
    [{ openapi: '3.2.0', paths: {} }, 'is OpenAPI 3.2.0; the generator reads OpenAPI 3.0 and 3.1 exports'],
    [{ openapi: '3.0', paths: {} }, 'is OpenAPI 3.0; the generator reads OpenAPI 3.0 and 3.1 exports'],
    [{ openapi: '4.0.0', paths: {} }, 'is OpenAPI 4.0.0;'],
  ])('rejects %j', (document, reason) => {
    const parsed = parseOpenapiDocument(JSON.stringify(document));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(reason);
  });
});

describe('OpenAPI 3.0 normalization', () => {
  it.each(['string', 'number', 'integer', 'boolean', 'object', 'array'])('turns nullable %s into a type list', (type) => {
    expect(normalized({ type, nullable: true, description: 'd' })).toEqual({ type: [type, 'null'], description: 'd' });
  });

  it('appends null to the enum of a nullable enum', () => {
    expect(normalized({ type: 'string', nullable: true, enum: ['a', 'b'] })).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
    expect(normalized({ type: 'string', nullable: true, enum: ['a', null] })).toEqual({ type: ['string', 'null'], enum: ['a', null] });
    expect(normalized({ nullable: true, enum: ['a'] })).toEqual({ enum: ['a', null] });
  });

  it('wraps a nullable schema without type in anyOf and keeps the annotations outside', () => {
    expect(normalized({
      nullable: true, description: 'Primary tag', example: { id: 'x' }, 'x-order': 1, allOf: [{ $ref: '#/components/schemas/Tag' }],
    })).toEqual({
      description: 'Primary tag', example: { id: 'x' }, 'x-order': 1,
      anyOf: [{ allOf: [{ $ref: '#/components/schemas/Tag' }] }, { type: 'null' }],
    });
    expect(normalized({ nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }] }))
      .toEqual({ anyOf: [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }] });
    expect(normalized({ nullable: true, $ref: '#/components/schemas/Tag' }))
      .toEqual({ anyOf: [{ $ref: '#/components/schemas/Tag' }, { type: 'null' }] });
    // A type next to a combinator stays inside: the combinator would still reject null.
    expect(normalized({ type: 'object', nullable: true, allOf: [{ $ref: '#/components/schemas/Tag' }] }))
      .toEqual({ anyOf: [{ type: 'object', allOf: [{ $ref: '#/components/schemas/Tag' }] }, { type: 'null' }] });
  });

  it('drops nullable false and a nullable schema that accepts null already', () => {
    expect(normalized({ type: 'string', nullable: false })).toEqual({ type: 'string' });
    expect(normalized({ nullable: true, description: 'any' })).toEqual({ description: 'any' });
  });

  it('turns boolean exclusive bounds into numbers', () => {
    expect(normalized({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: true }))
      .toEqual({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 9 });
    expect(normalized({ type: 'number', minimum: 0, exclusiveMinimum: false, maximum: 9, exclusiveMaximum: false }))
      .toEqual({ type: 'number', minimum: 0, maximum: 9 });
    expect(normalized({ type: 'number', exclusiveMinimum: true })).toEqual({ type: 'number' });
  });

  it('walks properties, items, additionalProperties, combinators and not', () => {
    const nullableString = { type: 'string', nullable: true };
    const expected = { type: ['string', 'null'] };
    expect(normalized({
      type: 'object',
      properties: { a: nullableString },
      additionalProperties: nullableString,
      allOf: [{ properties: { b: { type: 'array', items: nullableString } } }],
      not: nullableString,
    })).toEqual({
      type: 'object',
      properties: { a: expected },
      additionalProperties: expected,
      allOf: [{ properties: { b: { type: 'array', items: expected } } }],
      not: expected,
    });
  });

  it('never touches payloads or a property named nullable', () => {
    const schema = {
      type: 'object',
      properties: {
        nullable: { type: 'boolean' },
        exclusiveMinimum: { type: 'boolean' },
        mode: { type: 'object', enum: [{ nullable: true }], default: { nullable: true, exclusiveMinimum: true } },
      },
      example: { nullable: true, exclusiveMinimum: true, minimum: 1 },
      discriminator: { propertyName: 'nullable' },
      'x-extension': { nullable: true },
    };
    expect(normalized(schema)).toEqual(schema);
  });

  it('normalizes parameters, request bodies, responses and headers, inline and in components', () => {
    const nullable = { type: 'string', nullable: true };
    const expected = { type: ['string', 'null'] };
    const document = parse({
      openapi: '3.0.0',
      paths: {
        '/a': {
          parameters: [{ name: 'p', in: 'query', schema: nullable }],
          post: {
            parameters: [{ name: 'q', in: 'query', content: { 'application/json': { schema: nullable } } }],
            requestBody: { content: { 'application/json': { schema: nullable, example: { nullable: true } } } },
            responses: { 200: { headers: { 'X-H': { schema: nullable } }, content: { 'application/json': { schema: nullable } } } },
          },
        },
      },
      components: {
        parameters: { P: { name: 'p', in: 'query', schema: nullable } },
        requestBodies: { B: { content: { 'application/json': { schema: nullable } } } },
        responses: { R: { content: { 'application/json': { schema: nullable } } } },
        headers: { H: { schema: nullable } },
      },
    }) as unknown as Json;
    expect(document).toEqual({
      openapi: '3.0.0',
      paths: {
        '/a': {
          parameters: [{ name: 'p', in: 'query', schema: expected }],
          post: {
            parameters: [{ name: 'q', in: 'query', content: { 'application/json': { schema: expected } } }],
            requestBody: { content: { 'application/json': { schema: expected, example: { nullable: true } } } },
            responses: { 200: { headers: { 'X-H': { schema: expected } }, content: { 'application/json': { schema: expected } } } },
          },
        },
      },
      components: {
        parameters: { P: { name: 'p', in: 'query', schema: expected } },
        requestBodies: { B: { content: { 'application/json': { schema: expected } } } },
        responses: { R: { content: { 'application/json': { schema: expected } } } },
        headers: { H: { schema: expected } },
      },
    });
  });

  it('leaves no nullable keyword for the $ref sibling merge of dereference', () => {
    const document = parse({
      openapi: '3.0.0',
      paths: {},
      components: {
        schemas: {
          Tag: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          Task: { type: 'object', properties: { tag: { $ref: '#/components/schemas/Tag', nullable: true, description: 'd' } } },
        },
      },
    });
    const task = dereference(document, { $ref: '#/components/schemas/Task' }).value as Json;
    const validator = createJsonSchemaLike(task);
    expect(task.properties).toEqual({
      tag: { description: 'd', anyOf: [{ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { type: 'null' }] },
    });
    expect(validator.safeParse({ tag: null }).success).toBe(true);
    expect(validator.safeParse({ tag: { id: 'x' } }).success).toBe(true);
    expect(validator.safeParse({ tag: {} }).success).toBe(false);
  });

  it('is deterministic', () => {
    const text = readFileSync(`${SDK_ROOT}examples/openapi-3.0.tasks.json`, 'utf8');
    const first = parseOpenapiDocument(text);
    const second = parseOpenapiDocument(text);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.ok && fingerprints(first.document)).toEqual(second.ok && fingerprints(second.document));
  });

  it('compiles every schema of the 3.0 fixture with the runtime validator', () => {
    const document = parse(JSON.parse(readFileSync(`${SDK_ROOT}examples/openapi-3.0.tasks.json`, 'utf8')) as Json);
    const schemas = (document.components as { schemas: Json }).schemas;
    for (const name of Object.keys(schemas)) {
      expect(() => createJsonSchemaLike(dereference(document, schemas[name]).value as Json)).not.toThrow();
    }
  });
});

describe('OpenAPI 3.1 documents', () => {
  it.each([
    'examples/openapi.todo.json',
    'examples/php-runtime/api/openapi.json',
    'examples/vue-fastapi/api/openapi.json',
  ])('returns %s exactly as parsed', (path) => {
    const text = readFileSync(`${SDK_ROOT}${path}`, 'utf8');
    const parsed = parseOpenapiDocument(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.document).toStrictEqual(JSON.parse(text));
  });

  it('keeps 3.0 keywords of a 3.1 document as written', () => {
    const schema = { type: 'string', nullable: true, exclusiveMinimum: true };
    expect(normalized(schema, '3.1.0')).toEqual(schema);
  });
});
