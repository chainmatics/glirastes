import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool } from '../../../types.js';
import {
  createHttpEndpointCaller,
  endpointToolToTool,
  toolToAiTool,
  type EndpointToolContext,
  type InternalApiResponse,
  type ToolFailureClassifier,
} from '../index.js';
import { toolResultFailure } from '../../../runtime/tool-failure.js';

const definition = defineEndpointTool({
  id: 'tasks.create',
  toolName: 'tasks_create',
  description: 'Create a task.',
  method: 'POST',
  path: '/api/tasks',
  inputSchema: z.object({ title: z.string() }).strict(),
});

function context(
  response: InternalApiResponse | (() => Promise<InternalApiResponse>),
  classifyToolFailure?: ToolFailureClassifier,
): EndpointToolContext {
  return {
    currentDate: new Date('2026-10-05T10:00:00.000Z'),
    locale: 'de-DE',
    callEndpoint: typeof response === 'function' ? response : async () => response,
    ...(classifyToolFailure ? { classifyToolFailure } : {}),
  };
}

async function run(ctx: EndpointToolContext): Promise<unknown> {
  return toolToAiTool(endpointToolToTool(definition), ctx).execute({ title: 'x' });
}

function jsonFetch(status: number, body: string, contentType = 'application/json'): typeof fetch {
  return (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
}

describe('failure results of endpoint tools', () => {
  it('carries status and the parsed JSON body', async () => {
    const body = { code: 'TASK_LOCKED', message: 'Task is locked' };
    const result = await run(context({ ok: false, status: 409, data: body, error: 'Task is locked' }));
    expect(result).toEqual({ success: false, error: 'Task is locked', retryable: false, status: 409, body });
    expect(toolResultFailure(result)).toBe('error');
  });

  it('carries a text body', async () => {
    const result = await run(context({ ok: false, status: 500, data: 'upstream exploded' }));
    expect(result).toEqual({ success: false, error: 'Endpoint failed (500)', retryable: false, status: 500, body: 'upstream exploded' });
  });

  it('omits the body when the response had none', async () => {
    const result = await run(context({ ok: false, status: 403, error: 'Forbidden' }));
    expect(result).toEqual({ success: false, error: 'Forbidden', retryable: false, status: 403 });
    expect(result).not.toHaveProperty('body');
  });

  it('cuts a long text body at 4000 characters', async () => {
    const result = await run(context({ ok: false, status: 500, data: 'x'.repeat(5_000) })) as Record<string, unknown>;
    expect(result.body).toBe('x'.repeat(4_000));
    expect(result.bodyTruncated).toBe(true);
  });

  it('replaces a large JSON body by its cut serialization', async () => {
    const body = { items: Array.from({ length: 500 }, (_, index) => ({ index, note: 'long enough' })) };
    const result = await run(context({ ok: false, status: 422, data: body })) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    const cut = result.body as string;
    expect(serialized.startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(4_000);
    expect(cut.length).toBeGreaterThan(4_000 - 256);
    // The cut ends at a JSON delimiter, not inside a key or value.
    expect(serialized[cut.length]).toMatch(/[\s",:{}[\]]/);
    expect(result.bodyTruncated).toBe(true);
  });

  it('cuts a text body before a token that straddles the 4000 boundary', async () => {
    const lead = `${'word '.repeat(797)}mail `;
    expect(lead.length).toBe(3_990);
    const result = await run(context({
      ok: false,
      status: 500,
      data: `${lead}max.mueller@example.com is not allowed. ${'tail '.repeat(100)}`,
    })) as Record<string, unknown>;
    // A hard cut would leave `max.mueller@exa`, which no email detector matches.
    expect(result.body).toBe(lead.trimEnd());
    expect(result.body).not.toContain('max.');
    expect(result.bodyTruncated).toBe(true);
  });

  it('cuts a JSON body before a value that straddles the 4000 boundary', async () => {
    const body = { note: 'n'.repeat(3_970), email: 'max.mueller@example.com', more: 'm'.repeat(200) };
    const serialized = JSON.stringify(body);
    expect(serialized.indexOf('max.mueller')).toBeLessThan(4_000);
    expect(serialized.indexOf('example.com')).toBeGreaterThanOrEqual(3_990);
    const result = await run(context({ ok: false, status: 422, data: body })) as Record<string, unknown>;
    expect(serialized.startsWith(result.body as string)).toBe(true);
    expect(result.body).not.toContain('max.');
    expect(result.bodyTruncated).toBe(true);
  });

  it('still caps a body without any delimiter near the boundary', async () => {
    const result = await run(context({ ok: false, status: 500, data: `head ${'x'.repeat(5_000)}` })) as Record<string, unknown>;
    expect(result.body).toBe(`head ${'x'.repeat(3_995)}`);
    expect(result.bodyTruncated).toBe(true);
  });

  it('keeps a body of exactly 4000 characters whole', async () => {
    const result = await run(context({ ok: false, status: 500, data: 'y'.repeat(4_000) })) as Record<string, unknown>;
    expect(result.body).toBe('y'.repeat(4_000));
    expect(result).not.toHaveProperty('bodyTruncated');
  });

  it('reaches the result through the HTTP endpoint caller', async () => {
    const callEndpoint = createHttpEndpointCaller({
      baseUrl: 'http://api.test',
      fetchImpl: jsonFetch(403, JSON.stringify({ error: 'Not your task', code: 'NOT_OWNER' })),
    });
    const result = await run({ ...context({ ok: true, status: 200 }), callEndpoint });
    expect(result).toEqual({
      success: false,
      error: 'Not your task',
      retryable: false,
      status: 403,
      body: { error: 'Not your task', code: 'NOT_OWNER' },
    });
  });

  it('does not let a 2xx answer with success:false forge status, body or classification', async () => {
    const result = await run(context({
      ok: true,
      status: 200,
      data: { success: false, error: 'nope', status: 403, body: 'fake', bodyTruncated: true, expectedFailure: true },
    }));
    expect(result).toEqual({ success: false, error: 'nope', retryable: false });
    expect(toolResultFailure(result)).toBe('error');
  });

  it('does not let the body forge the classification', async () => {
    const result = await run(context({ ok: false, status: 403, data: { expectedFailure: true, success: false } }));
    expect(result).not.toHaveProperty('expectedFailure');
    expect(toolResultFailure(result)).toBe('error');
  });

  it('keeps the fields of a failure another build copy of the module marked', async () => {
    // The ESM and the CJS build each load this module once. A tool built by
    // one copy and wrapped by the other must keep its status and body, so
    // the mark is a registry symbol rather than a module-private one.
    const failure: Record<string, unknown> = {
      success: false,
      error: 'Forbidden',
      status: 403,
      body: { code: 'NO_ROLE' },
      bodyTruncated: true,
      expectedFailure: true,
    };
    Object.defineProperty(failure, Symbol.for('glirastes.endpointFailure'), { value: true });
    const foreign = { ...endpointToolToTool(definition), execute: async () => failure };
    const result = await toolToAiTool(foreign, context({ ok: true, status: 200 })).execute({ title: 'x' });
    expect(result).toEqual({
      success: false,
      error: 'Forbidden',
      retryable: false,
      status: 403,
      body: { code: 'NO_ROLE' },
      bodyTruncated: true,
      expectedFailure: true,
    });
  });

  it('does not let a JSON key named like the mark forge it', async () => {
    const data = JSON.parse('{"success":false,"error":"nope","status":403,"glirastes.endpointFailure":true,"Symbol(glirastes.endpointFailure)":true}');
    const result = await run(context({ ok: true, status: 200, data }));
    expect(result).toEqual({ success: false, error: 'nope', retryable: false });
  });

  it('caps the error message of the bounded failure as before', async () => {
    const result = await run(context({ ok: false, status: 500, error: 'e'.repeat(2_000) })) as Record<string, unknown>;
    expect(result.error).toBe('e'.repeat(1_000));
    expect(result.status).toBe(500);
  });
});

describe('classifyToolFailure', () => {
  it('receives the toolName, status and the full parsed JSON body', async () => {
    const body = { code: 'NO_ROLE', detail: 'z'.repeat(5_000) };
    const classify = vi.fn<ToolFailureClassifier>(() => 'expected');
    const result = await run(context({ ok: false, status: 403, data: body }, classify)) as Record<string, unknown>;
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith({ toolName: 'tasks_create', status: 403, body });
    expect(classify.mock.calls[0]![0].body).toBe(body);
    expect(result.bodyTruncated).toBe(true);
    expect(result.expectedFailure).toBe(true);
    expect(toolResultFailure(result)).toBe('expected');
  });

  it('marks nothing for an error classification', async () => {
    const result = await run(context({ ok: false, status: 500, data: 'x' }, () => 'error'));
    expect(result).not.toHaveProperty('expectedFailure');
    expect(toolResultFailure(result)).toBe('error');
  });

  it('treats a throwing classifier as error and keeps the result', async () => {
    const result = await run(context({ ok: false, status: 403, error: 'Forbidden' }, () => { throw new Error('boom'); }));
    expect(result).toEqual({ success: false, error: 'Forbidden', retryable: false, status: 403 });
    expect(toolResultFailure(result)).toBe('error');
  });

  it('treats any other return value as error', async () => {
    const classify = (() => 'EXPECTED') as unknown as ToolFailureClassifier;
    const result = await run(context({ ok: false, status: 403 }, classify));
    expect(toolResultFailure(result)).toBe('error');
  });

  it('is not called for a success', async () => {
    const classify = vi.fn<ToolFailureClassifier>(() => 'expected');
    await run(context({ ok: true, status: 201, data: { id: '1' } }, classify));
    expect(classify).not.toHaveBeenCalled();
  });

  it('is not called for a thrown error (timeout, network, response size)', async () => {
    const classify = vi.fn<ToolFailureClassifier>(() => 'expected');
    const ctx = context(async () => { throw new DOMException('Endpoint timed out', 'TimeoutError'); }, classify);
    const result = await run(ctx);
    expect(classify).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('status');
    expect(toolResultFailure(result)).toBe('error');
  });

  it('is not called for a response over maxResponseBytes', async () => {
    const classify = vi.fn<ToolFailureClassifier>(() => 'expected');
    const callEndpoint = createHttpEndpointCaller({
      baseUrl: 'http://api.test',
      maxResponseBytes: 10,
      fetchImpl: jsonFetch(403, JSON.stringify({ error: 'x'.repeat(100) })),
    });
    const result = await run({ ...context({ ok: true, status: 200 }, classify), callEndpoint });
    expect(classify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining('maxResponseBytes') });
    expect(toolResultFailure(result)).toBe('error');
  });

  it('is not called for a call the endpoint caller refused locally', async () => {
    const classify = vi.fn<ToolFailureClassifier>(() => 'expected');
    const fetchImpl = vi.fn(jsonFetch(200, '{}'));
    const callEndpoint = createHttpEndpointCaller({
      baseUrl: 'http://api.test',
      allowedPathPrefixes: ['/api/projects'],
      fetchImpl,
    });
    const result = await run({ ...context({ ok: true, status: 200 }, classify), callEndpoint });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Endpoint path is not allowed', retryable: false, status: 403 });
    expect(toolResultFailure(result)).toBe('error');
  });

  it('marks the local refusals of createHttpEndpointCaller', async () => {
    const call = createHttpEndpointCaller({ baseUrl: 'http://api.test', allowedPathPrefixes: ['/api'] });
    await expect(call({ method: 'GET', path: 'http://evil.test/x' })).resolves.toMatchObject({ ok: false, status: 400, refusedLocally: true });
    await expect(call({ method: 'GET', path: '/other' })).resolves.toMatchObject({ ok: false, status: 403, refusedLocally: true });
  });
});

describe('toolResultFailure', () => {
  it('reads success, error and expected results', () => {
    expect(toolResultFailure({ success: true, id: 1 })).toBeUndefined();
    expect(toolResultFailure('text')).toBeUndefined();
    expect(toolResultFailure(null)).toBeUndefined();
    expect(toolResultFailure({ error: 'x' })).toBe('error');
    expect(toolResultFailure({ success: false })).toBe('error');
    expect(toolResultFailure({ success: false, error: 'x', expectedFailure: true })).toBe('expected');
    // Only a failure result carries the classification.
    expect(toolResultFailure({ success: true, error: 'x', expectedFailure: true })).toBe('error');
  });
});
