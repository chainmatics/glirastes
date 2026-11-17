import { describe, expect, it } from 'vitest';
import { projectOutputSchema, resolveOutputFields, unknownOutputFields, type DeclaredOutputFields } from './output-fields.js';
import type { JsonSchemaLike } from './types.js';

const DESIGN: JsonSchemaLike = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          fileUrl: { type: 'string', examples: ['https://s3.example/x?sig=1'] },
          owner: { anyOf: [{ type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'email'] }, { type: 'null' }] },
          draftVersion: {
            type: 'object',
            properties: { title: { type: 'string' }, fileUrl: { type: 'string' }, variants: { type: 'array', items: { type: 'object', properties: { size: { type: 'integer' }, fileUrl: { type: 'string' } }, required: ['size', 'fileUrl'] } } },
            required: ['title', 'fileUrl'],
          },
          extra: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['id', 'name', 'fileUrl'],
      },
    },
    meta: { type: 'object', properties: { page: { type: 'integer' } } },
  },
  required: ['data', 'meta'],
  examples: [{ data: [{ fileUrl: 'https://s3.example/y?sig=2' }] }],
};

describe('projectOutputSchema', () => {
  it('keeps only the allowed fields; required only for whole fields', () => {
    const { schema, unprojected } = projectOutputSchema(DESIGN, ['data[].name', 'data[].owner.name', 'meta']);
    expect(unprojected).toBe(0);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              owner: { anyOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }] },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        meta: { type: 'object', properties: { page: { type: 'integer' } } },
      },
      required: ['meta'],
      additionalProperties: false,
    });
  });

  it('removes denied paths and any-depth keys everywhere, also from required and examples, without changing the input', () => {
    const before = JSON.stringify(DESIGN);
    const exact = projectOutputSchema(DESIGN, undefined, ['data[].draftVersion.variants[].fileUrl']).schema as never as {
      properties: { data: { items: { properties: Record<string, { properties: Record<string, { items: { properties: object; required: string[] } }> }> } } };
    };
    const variants = exact.properties.data.items.properties.draftVersion!.properties.variants!.items;
    expect(Object.keys(variants.properties)).toEqual(['size']);
    expect(variants.required).toEqual(['size']);
    expect(JSON.stringify(exact)).toContain('fileUrl');
    const any = projectOutputSchema(DESIGN, undefined, ['**.fileUrl']).schema;
    expect(JSON.stringify(any)).not.toContain('fileUrl');
    expect(JSON.stringify(any)).not.toContain('s3.example');
    expect(JSON.stringify(DESIGN)).toBe(before);
  });

  it('reduces a list response under data and counts what it cannot reduce', () => {
    const list: JsonSchemaLike = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, secret: { type: 'string' } } } };
    expect(projectOutputSchema(list, ['data[].id']).schema).toEqual({
      type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
    });
    expect(projectOutputSchema({ type: 'object', properties: { a: { $ref: '#/$defs/A' } } }, ['a.b'])).toMatchObject({ unprojected: 1 });
    // An opaque schema says nothing and stays.
    expect(projectOutputSchema({}, ['a']).schema).toEqual({});
  });
});

describe('unknownOutputFields', () => {
  it('reports paths a closed schema does not have, never for open or opaque parts', () => {
    expect(unknownOutputFields(DESIGN, [
      'data[].name', 'data[].nme', 'data.name', 'meta.page', 'meta.pgae', 'data[].extra.anything', 'success', 'uiAction',
      '**.fileUrl', '**.fileUlr', '**.size',
    ], )).toEqual(['data[].nme', 'data.name', 'meta.pgae', '**.fileUlr']);
    expect(unknownOutputFields({}, ['x', '**.y'])).toEqual([]);
    // An any-depth key named nowhere in the declared parts is reported even next to open parts.
    expect(unknownOutputFields({ type: 'object', properties: { a: {}, meta: { type: 'object' } } }, ['**.b', '**.a'])).toEqual(['**.b']);
    expect(unknownOutputFields({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }, ['data[].id', 'data[].x', 'id']))
      .toEqual(['data[].x', 'id']);
  });
});

describe('resolveOutputFields', () => {
  const declared = (fields: Partial<DeclaredOutputFields>): DeclaredOutputFields => ({ where: 'api.json GET /x', form: 'openapi', ...fields });
  const codes = (result: ReturnType<typeof resolveOutputFields>) => result.findings.map((finding) => [finding.code, finding.severity]);

  it('reports nothing and changes nothing without a declaration', () => {
    expect(resolveOutputFields('GET /x', undefined, DESIGN)).toEqual({ findings: [] });
  });

  it('intersects the default view with the upper bound and reports each problem once', () => {
    const result = resolveOutputFields('GET /x', declared({
      allowed: ['data', 'meta'], denied: ['**.fileUrl', 'data[].owner.email', 'data[].nope'], default: ['data[].fileUrl', 'data[].name', 'data[].owner', 'other'],
    }), DESIGN);
    expect(codes(result)).toEqual([
      ['output-field-unknown', 'warning'],
      ['output-field-unknown', 'warning'],
      ['output-default-fields-outside-allowed', 'warning'],
      ['output-default-fields-denied', 'warning'],
    ]);
    expect(result.findings[0]!.message).toContain('NOT excluded');
    expect(result.findings[0]!.message).toContain('data[].nope');
    expect(result.default).toEqual(['data[].name', 'data[].owner']);
    expect(result.denied).toEqual(['**.fileUrl', 'data[].owner.email', 'data[].nope']);
    expect(JSON.stringify(result.output)).not.toContain('fileUrl');
    expect(JSON.stringify(result.output)).not.toContain('email');
  });

  it('fails closed for an invalid upper bound: nothing allowed', () => {
    for (const fields of [{ allowed: 'invalid' as const }, { denied: 'invalid' as const }]) {
      const result = resolveOutputFields('GET /x', declared({ ...fields, default: ['data[].name'] }), DESIGN);
      expect(result.allowed).toEqual([]);
      expect(result.default).toEqual([]);
      expect(result.output).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    }
    expect(resolveOutputFields('GET /x', declared({ default: 'invalid' }), DESIGN)).toEqual({ findings: [] });
  });

  it('warns when a part of the schema cannot be reduced', () => {
    const result = resolveOutputFields('GET /x', declared({ allowed: ['a.b'] }), { type: 'object', properties: { a: { $ref: '#/$defs/A' } } });
    expect(codes(result)).toEqual([['output-schema-unprojected', 'warning']]);
  });
});

describe('review fixes', () => {
  const declared = (fields: Partial<DeclaredOutputFields>): DeclaredOutputFields => ({ where: 'api.json GET /x', form: 'openapi', ...fields });

  it('a denied path ending in [] empties the entries in the schema too', () => {
    const list: JsonSchemaLike = { type: 'object', properties: { tokens: { type: 'array', items: { type: 'string', examples: ['TOK'] } } } };
    expect(projectOutputSchema(list, undefined, ['tokens[]']).schema).toEqual({
      type: 'object', properties: { tokens: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false } } },
    });
  });

  it('warns about an any-depth key the declared schema does not name, next to open objects, with a case near-miss', () => {
    const result = resolveOutputFields('GET /x', declared({ denied: ['**.fileurl', 'data[].draftVersion.fileurl', '**.extra'] }), DESIGN);
    const messages = result.findings.map((finding) => finding.message);
    expect(result.findings.map((finding) => finding.code)).toEqual(['output-field-unknown', 'output-field-unknown']);
    expect(messages[0]).toContain('data[].draftVersion.fileurl (the schema has fileUrl; names match exactly, case included)');
    expect(messages[1]).toContain('not found in the declared response schema: **.fileurl (the schema has fileUrl');
    expect(messages[1]).toContain('if the field only occurs in undeclared parts, ignore this');
    expect(messages[1]).toContain('NOT excluded');
  });
});

describe('review round 4: an allow-list keeps an allOf contract satisfiable', () => {
  it('does not close the branches of an allOf against each other', () => {
    const inherited = {
      allOf: [
        { type: 'object', properties: { id: { type: 'string' }, secret: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    } as JsonSchemaLike;
    expect(projectOutputSchema(inherited, ['id', 'name']).schema).toEqual({
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    });
    // A plain object and the variants of a oneOf (now an anyOf) stay closed.
    const plain = projectOutputSchema({ type: 'object', properties: { id: { type: 'string' }, secret: {} } } as JsonSchemaLike, ['id']).schema;
    expect(plain).toMatchObject({ additionalProperties: false });
    const either = projectOutputSchema({ oneOf: [{ type: 'object', properties: { id: { type: 'string' }, secret: {} } }] } as JsonSchemaLike, ['id']).schema as { anyOf: unknown[] };
    expect(either.anyOf[0]).toMatchObject({ additionalProperties: false });
  });
});

describe('review round 5: joined deny-lists stay within the limit of one tool', () => {
  const app = Array.from({ length: 200 }, (_, index) => `**.k${index}`);
  const declared = (fields: Partial<DeclaredOutputFields>): DeclaredOutputFields => ({ where: 'api.json GET /x', form: 'openapi', ...fields });

  it('fails closed instead of writing a contract with more than 200 paths', () => {
    const result = resolveOutputFields('GET /x', declared({ appDenied: app, denied: ['data[].name'] }), DESIGN);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'output-denied-fields-invalid', severity: 'needs_attention' }));
    // Nothing is cut off: the tool shows nothing and stays disabled.
    expect(result.allowed).toEqual([]);
    expect(result.denied).toBeUndefined();
  });

  it('accepts exactly 200 joined paths', () => {
    const result = resolveOutputFields('GET /x', declared({ appDenied: app.slice(0, 199), denied: ['data[].name'] }), DESIGN);
    expect(result.findings.map((finding) => finding.code)).not.toContain('output-denied-fields-invalid');
    expect(result.denied).toHaveLength(200);
  });
});

describe('review round 6: a projected oneOf is no longer exclusive', () => {
  const variant = (kind: string) => ({ type: 'object', properties: { kind: { const: kind }, name: { type: 'string' } }, required: ['kind', 'name'] });
  const union = { oneOf: [variant('a'), variant('b')] } as JsonSchemaLike;

  it.each([
    ['an exact deny path', undefined, ['kind']],
    ['an any-depth key', undefined, ['**.kind']],
    ['an allow-list', ['name'], undefined],
  ] as const)('with %s the variants become an anyOf', (_label, allowed, denied) => {
    const schema = projectOutputSchema(union, allowed as string[] | undefined, denied as string[] | undefined).schema as { oneOf?: unknown; anyOf?: unknown[] };
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toHaveLength(2);
    expect(JSON.stringify(schema)).not.toContain('kind');
  });
});

describe('review round 7: root unions and dependent constraints', () => {
  const entry = { type: 'object', properties: { id: { type: 'string' }, secret: { type: 'string' } } };
  const nullableList = { anyOf: [{ type: 'array', items: entry }, { type: 'null' }] } as JsonSchemaLike;

  it('projects a nullable list under data, as the result travels', () => {
    const allowed = projectOutputSchema(nullableList, ['data[].id']);
    expect(allowed.unprojected).toBe(0);
    expect(JSON.stringify(allowed.schema)).toContain('"id"');
    expect(JSON.stringify(allowed.schema)).not.toContain('secret');
    const denied = projectOutputSchema(nullableList, undefined, ['data[].secret']);
    expect(JSON.stringify(denied.schema)).toContain('"id"');
    expect(JSON.stringify(denied.schema)).not.toContain('secret');
  });

  it('reports a union of a record and a list instead of projecting one of the shapes', () => {
    const mixed = { anyOf: [{ type: 'array', items: entry }, { type: 'object', properties: { data: { type: 'array', items: entry } } }] } as JsonSchemaLike;
    expect(projectOutputSchema(mixed, ['data[].id'])).toEqual({ schema: mixed, unprojected: 1 });
    // Without a declaration nothing is reported.
    expect(projectOutputSchema(mixed, undefined)).toEqual({ schema: mixed, unprojected: 0 });
  });

  it.each([['an exact path', ['secret']], ['an any-depth key', ['**.secret']]])(
    'drops a constraint that depended on a property removed by %s', (_label, denied) => {
      const only = { type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'], minProperties: 1, additionalProperties: false } as JsonSchemaLike;
      expect(projectOutputSchema(only, undefined, denied).schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
      // An object that loses nothing keeps its constraints.
      const other = { type: 'object', properties: { id: { type: 'string' } }, minProperties: 1 } as JsonSchemaLike;
      expect(projectOutputSchema(other, undefined, denied).schema).toMatchObject({ minProperties: 1 });
    },
  );
});
