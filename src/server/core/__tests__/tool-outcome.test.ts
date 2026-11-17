import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool } from '../../../types.js';
import { createHttpEndpointCaller, endpointToolToTool, toolToAiTool, type EndpointToolContext, type InternalApiResponse } from '../index.js';
import { isOutcomeUnknown } from '../tool-outcome.js';

/**
 * Independent re-review M3: a write whose effect the answer does not tell
 * (gateway error, lost connection, unreadable answer) is "outcome unknown",
 * marked so that no backend payload can claim or hide it.
 */
const tool = (method: 'POST' | 'GET') => endpointToolToTool(defineEndpointTool({
  id: 'tasks.create', toolName: 'tasks_create', description: 'Create a task.', method, path: '/api/tasks',
  inputSchema: z.object({ title: z.string() }).strict(),
}));

function context(callEndpoint: EndpointToolContext['callEndpoint']): EndpointToolContext {
  return { currentDate: new Date('2026-11-17T10:00:00.000Z'), locale: 'de-DE', callEndpoint };
}

const run = (method: 'POST' | 'GET', callEndpoint: EndpointToolContext['callEndpoint']) =>
  toolToAiTool(tool(method), context(callEndpoint)).execute({ title: 'x' });

const answer = (response: InternalApiResponse) => async () => response;

describe('tool outcome unknown', () => {
  it.each([408, 502, 504])('a %i answer to a write leaves the outcome unknown', async (status) => {
    const result = await run('POST', answer({ ok: false, status, data: 'gateway' }));
    expect(isOutcomeUnknown(result)).toBe(true);
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
  });

  it('a 504 answer to a read and a 500 answer to a write are plain failures', async () => {
    expect(isOutcomeUnknown(await run('GET', answer({ ok: false, status: 504 })))).toBe(false);
    expect(isOutcomeUnknown(await run('POST', answer({ ok: false, status: 500 })))).toBe(false);
  });

  it('a backend body with an outcome field does not claim the marker', async () => {
    const ok = await run('POST', answer({ ok: true, status: 200, data: { outcome: 'unknown' } }));
    const failed = await run('POST', answer({ ok: false, status: 409, data: { outcome: 'unknown' } }));
    expect(isOutcomeUnknown(ok)).toBe(false);
    expect(isOutcomeUnknown(failed)).toBe(false);
  });

  it('a connection reset after sending leaves the outcome unknown; a refused connection does not', async () => {
    const reset = await run('POST', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
    const refused = await run('POST', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    expect(isOutcomeUnknown(reset)).toBe(true);
    expect(isOutcomeUnknown(refused)).toBe(false);
  });

  it('an answer to a write that cannot be read leaves the outcome unknown', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(100), { status: 201, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const callEndpoint = createHttpEndpointCaller({ baseUrl: 'http://api.test', maxResponseBytes: 10, fetchImpl });
    const result = await run('POST', callEndpoint);
    expect(isOutcomeUnknown(result)).toBe(true);
    const read = await run('GET', createHttpEndpointCaller({ baseUrl: 'http://api.test', maxResponseBytes: 10, fetchImpl }));
    expect(isOutcomeUnknown(read)).toBe(false);
  });
});
