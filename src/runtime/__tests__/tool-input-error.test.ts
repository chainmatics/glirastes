import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJsonSchemaLike } from '../json-schema.js';
import {
  describeToolInputIssues,
  INVALID_TOOL_INPUT_INSTRUCTION,
  MAX_TOOL_INPUT_ISSUES,
  ToolInputValidationError,
  toolInputIssues,
} from '../tool-input-error.js';

const zodIssues = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('expected a failure');
  return toolInputIssues(parsed.error);
};

describe('toolInputIssues', () => {
  it('names field and expectation of Zod issues, not the value', () => {
    const schema = z.object({
      playlistId: z.string().uuid(),
      kind: z.enum(['a', 'b']),
      count: z.number().int().min(1),
      title: z.string(),
      tags: z.array(z.string()).max(2),
    }).strict();
    const result = zodIssues(schema, {
      playlistId: 'Abend-Promos', kind: 'zzz-secret', count: 0, tags: ['x', 'y', 'z'], extra: 1,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      { path: 'playlistId', expected: 'expected format uuid' },
      { path: 'kind', expected: 'expected one of "a", "b"' },
      { path: 'count', expected: 'number must be at least 1' },
      { path: 'title', expected: 'required (string)' },
    ]));
    expect(result.issues).toHaveLength(MAX_TOOL_INPUT_ISSUES);
    expect(result.omitted).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Abend-Promos');
    expect(JSON.stringify(result)).not.toContain('zzz-secret');
  });

  it('names field and expectation of JSON Schema issues, not the value', () => {
    const schema = createJsonSchemaLike({
      type: 'object',
      additionalProperties: false,
      required: ['playlistId', 'kind'],
      properties: {
        playlistId: { type: 'string', format: 'uuid' },
        kind: { enum: ['a', 'b'] },
        nested: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    });
    const parsed = schema.safeParse({ playlistId: 'Abend-Promos', nested: { id: 'secret-text' } });
    expect(parsed.success).toBe(false);
    const result = toolInputIssues(parsed.success ? undefined : parsed.error);
    expect(result.issues).toEqual(expect.arrayContaining([
      { path: 'kind', expected: 'required' },
      { path: 'playlistId', expected: 'expected format uuid' },
      { path: 'nested.id', expected: 'expected integer' },
    ]));
    expect(JSON.stringify(result)).not.toContain('Abend-Promos');
    expect(JSON.stringify(result)).not.toContain('secret-text');
  });

  it('does not use a message that quotes the received value (Zod v3 enums)', () => {
    const result = toolInputIssues({
      issues: [{
        code: 'invalid_enum_value', path: ['kind'], options: ['a', 'b'], received: 'top-secret',
        message: "Invalid enum value. Expected 'a' | 'b', received 'top-secret'",
      }],
    });
    expect(result.issues).toEqual([{ path: 'kind', expected: 'expected one of "a", "b"' }]);
  });

  it('bounds paths, unknown keys and fallback messages', () => {
    const result = toolInputIssues({
      issues: [
        { code: 'custom', path: ['a'.repeat(500)], message: 'x'.repeat(500) },
        { code: 'unrecognized_keys', path: [], keys: Array.from({ length: 30 }, (_, i) => `k${i}${'y'.repeat(100)}`) },
      ],
    });
    for (const issue of result.issues) {
      expect(issue.path.length).toBeLessThanOrEqual(80);
      expect(issue.expected.length).toBeLessThanOrEqual(120);
    }
  });

  it('reads nothing from an error without issues', () => {
    expect(toolInputIssues(new Error('Value: {"secret":1}'))).toEqual({ issues: [], omitted: 0 });
    expect(describeToolInputIssues([])).toBe(`The arguments do not match the input schema. ${INVALID_TOOL_INPUT_INSTRUCTION}`);
  });
});

describe('ToolInputValidationError', () => {
  it('carries tool, fields and expectations with the instruction', () => {
    const error = new ToolInputValidationError('playlists_get', [{ path: 'playlistId', expected: 'expected format uuid' }], 2);
    expect(error.message).toBe('Invalid input for tool playlists_get: playlistId: expected format uuid; 2 more. '
      + 'Correct the arguments and call the tool again; look up missing ids with a read tool instead of asking the user.');
    expect(error).toMatchObject({ name: 'ToolInputValidationError', toolName: 'playlists_get', omittedIssues: 2 });
  });
});
