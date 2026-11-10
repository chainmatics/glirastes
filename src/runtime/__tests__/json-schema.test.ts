import { describe, expect, it } from 'vitest';
import { createJsonSchemaLike } from '../json-schema.js';

describe('createJsonSchemaLike', () => {
  it('validates generated local execution schemas without Zod source files', () => {
    const schema = createJsonSchemaLike({
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1 },
        priority: {
          type: 'string',
          enum: ['hoch', 'mittel', 'niedrig'],
          default: 'mittel',
        },
      },
      required: ['id', 'title'],
    });

    expect(schema.safeParse({
      id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04',
      title: 'Migration',
    })).toEqual({
      success: true,
      data: {
        id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04',
        title: 'Migration',
        priority: 'mittel',
      },
    });
    expect(schema.safeParse({
      id: 'not-a-uuid',
      title: 'Migration',
    }).success).toBe(false);
    expect(schema.safeParse({
      id: 'not-a-uuid',
      title: '',
      unknown: true,
    })).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({ message: expect.any(String) }),
        ]),
      },
    });
  });

  it('strips additional output properties only when explicitly enabled', () => {
    const contract = {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    } as const;
    const response = {
      tasks: [{ title: 'Pilot pruefen', holidayName: 'Feiertag' }],
    };

    expect(createJsonSchemaLike(contract).safeParse(response).success)
      .toBe(false);
    expect(createJsonSchemaLike(contract, {
      stripAdditionalProperties: true,
    }).safeParse(response)).toEqual({
      success: true,
      data: { tasks: [{ title: 'Pilot pruefen' }] },
    });
  });
});
