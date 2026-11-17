import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { createPiiShield } from '../../../pii-shield/index.js';
import { defineEndpointTool, defineTool, type PipelineResult, type ToolRegistry } from '../../../../types.js';
import { endpointToolToTool, type InternalApiResponse } from '../../../core/index.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';
import { executeTool } from '../server-action-helper.js';
import { streamChunks } from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A paginated list whose entries carry a signed URL and an internal cost the model must never see. */
const designs: InternalApiResponse = {
  ok: true,
  status: 200,
  data: {
    data: Array.from({ length: 30 }, (_, index) => ({
      id: `design-${index}`, name: `Design ${index}`, cost: { cents: 4711 + index },
      draftVersion: { title: `Draft ${index}`, variants: [{ size: 1, fileUrl: `https://s3.example/v?X-Signature=SIG${index}` }] },
      notes: 'n'.repeat(400),
    })),
    meta: { page: 1, total: 30 },
  },
};

const SECRETS = ['X-Signature', 'fileUrl', '"cost"', 'cents', '4711'];

function designsTool() {
  return endpointToolToTool(defineEndpointTool({
    id: 'designs.list', toolName: 'designs_list', description: 'List designs.', method: 'GET', path: '/api/designs',
    inputSchema: z.object({}).strict(),
    outputAllowedFields: ['data', 'meta'],
    outputDeniedFields: ['**.fileUrl', 'data[].cost'],
    outputDefaultFields: ['data[].id', 'data[].name', 'meta'],
  }));
}

const post = (text: string) => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
});

/** The model itself names data[].cost and the fileUrl path in its read: those echoes do not count. */
const unasked = (text: string) => text
  .replaceAll('data[].draftVersion.variants[].fileUrl', 'ASKED').replaceAll('data[].cost', 'ASKED');

const noSecrets = (text: string) => {
  for (const secret of SECRETS) expect(unasked(text)).not.toContain(secret);
};

/** The browser wire of a model turn that lists designs, then reads the overview's omitted fields. */
async function modelTurn(config: Partial<AiChatHandlerFullConfig>) {
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      step += 1;
      const id = /r[ow]_[0-9a-z]{8}/.exec(JSON.stringify(options.prompt))?.[0];
      const chunks = step === 1
        ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'designs_list', input: '{}' }]
        : step === 2 && id
          ? [{
              type: 'tool-call', toolCallId: 'call-2', toolName: 'read_result',
              input: JSON.stringify({ resultId: id, fields: ['data[].draftVersion', 'data[].cost', 'data[].draftVersion.variants[].fileUrl'] }),
            }]
          : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }];
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...chunks,
          { type: 'finish', finishReason: { unified: chunks[0]!.type === 'tool-call' ? 'tool-calls' : 'stop', raw: undefined }, usage },
        ] as never),
      };
    },
  });
  const handler = createAiChatHandler({
    tools: { designs_list: designsTool() }, model, systemPrompt: 'A', endpointCaller: () => async () => designs, ...config,
  } as AiChatHandlerFullConfig);
  const wire = await (await handler(post('Show designs'))).text();
  return { wire, prompts: model.doStreamCalls.map((call) => JSON.stringify(call.prompt)) };
}

describe('output fields on every path a tool result takes', () => {
  it('a model turn with result handles: neither the browser wire nor any model prompt shows a removed field', async () => {
    const { wire, prompts } = await modelTurn({});
    expect(wire).toContain('"_result"');
    expect(wire).toContain('draftVersion');
    noSecrets(wire);
    // The model asked for data[].cost and the fileUrl path itself: they come back as unknown fields only.
    noSecrets(prompts.join('\n'));
    expect(prompts.join('\n')).toContain('Draft 3');
  });

  it('a model turn with a PII shield seals only the bounded result', async () => {
    const shield = createPiiShield({ locale: 'en-US', detector: { detect: () => [] } });
    const { wire } = await modelTurn({ piiShield: shield });
    noSecrets(wire);
    expect(wire).toContain('"_result"');
  });

  const pipelineResult: PipelineResult = {
    model: { modelId: 'fixture' }, tools: ['designs_list'], sanitizedInput: 'designs',
    intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
  };

  it.each([
    ['legacy', false],
    ['pipeline', true],
  ] as const)('the %s path without result handles applies the bound and the default view', async (_mode, withPipeline) => {
    let output: unknown;
    const handler = createAiChatHandler({
      tools: { designs_list: designsTool() },
      model: {},
      systemPrompt: 'A',
      resultHandles: false,
      endpointCaller: () => async () => designs,
      ...(withPipeline ? { pipeline: { process: async () => pipelineResult } } : {}),
      streamHandler: async (ctx) => {
        const tool = ctx.tools.designs_list as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> };
        output = await tool.execute({}, { toolCallId: 'call-1', messages: [] });
        return new Response('ok');
      },
    } as AiChatHandlerFullConfig);
    await (await handler(post('designs'))).text();
    const text = JSON.stringify(output);
    noSecrets(text);
    expect(text).not.toContain('read_result');
    expect(output).toMatchObject({ data: expect.any(Array), _truncated: { hint: expect.stringContaining('cannot be read in this turn') } });
    expect(Object.keys((output as { data: object[] }).data[0]!)).toEqual(['id', 'name']);
  });

  it('a registry tool named read_result: the turn keeps no handles, the view still applies', async () => {
    let output: unknown;
    const registry: ToolRegistry = {
      designs_list: designsTool(),
      read_result: defineTool({ id: 'read_result', description: 'App tool.', inputSchema: z.object({}), execute: async () => ({}) }),
    };
    const handler = createAiChatHandler({
      tools: registry, model: {}, systemPrompt: 'A', endpointCaller: () => async () => designs,
      streamHandler: async (ctx) => {
        const tool = ctx.tools.designs_list as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> };
        output = await tool.execute({}, { toolCallId: 'call-1', messages: [] });
        return new Response('ok');
      },
    } as AiChatHandlerFullConfig);
    await (await handler(post('designs'))).text();
    noSecrets(JSON.stringify(output));
    expect(output).not.toHaveProperty('_result');
    expect(output).toHaveProperty('_truncated.omitted');
  });

  it('a direct command: the browser copy of the result is bounded', async () => {
    const command = formatChatCommandMessage({ commandId: 'designs.list', tool: 'designs.list', args: {}, label: '/Designs' });
    const handler = createAiChatHandler({
      tools: { designs_list: designsTool() }, model: {}, systemPrompt: 'A', endpointCaller: () => async () => designs,
    } as AiChatHandlerFullConfig);
    const chunks = await streamChunks(await handler(post(command)));
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')?.output;
    expect(output).toBeDefined();
    noSecrets(JSON.stringify(chunks));
    expect(JSON.stringify(output)).not.toContain('read_result');
  });

  it('a Server Action (executeTool) applies the upper bound, not the default view', async () => {
    const tool = defineTool({
      id: 'designs.raw', description: 'Raw.', inputSchema: z.object({}),
      outputAllowedFields: ['data'], outputDeniedFields: ['**.fileUrl', 'data[].cost'], outputDefaultFields: ['data[].id'],
      execute: async () => ({ success: true, ...(designs.data as object), uiAction: { type: 'refresh' } }),
    });
    const result = await executeTool({ toolName: 'designs_raw', input: {}, tools: { designs_raw: tool } });
    noSecrets(JSON.stringify(result));
    expect(JSON.stringify(result)).toContain('draftVersion');
    expect(result.uiAction).toEqual({ type: 'refresh' });
    expect(result.data).not.toHaveProperty('meta');
  });
});
