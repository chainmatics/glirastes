import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { defineEndpointTool, defineTool, type PipelineResult, type ToolContext } from '../../../../types.js';
import {
  endpointToolToTool,
  toolToAiTool,
  type InternalApiResponse,
} from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never),
    }),
  });
}

/** 20 playlists of ~8,000 characters each in a paged API response (`{ data: { items, page } }`). */
const playlists: InternalApiResponse = {
  ok: true,
  status: 200,
  data: {
    data: {
      items: Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, name: `List ${index}`, tracks: 'x'.repeat(8_000) })),
      page: 1,
    },
  },
};

function listTool(maxResultChars?: number) {
  return endpointToolToTool(defineEndpointTool({
    id: 'playlists.list',
    toolName: 'playlists_list',
    description: 'List playlists.',
    method: 'GET',
    path: '/api/playlists',
    inputSchema: z.object({ page: z.number().optional(), pageSize: z.number().optional() }).strict(),
    ...(maxResultChars !== undefined ? { maxResultChars } : {}),
  }));
}

const context = (): ToolContext & { callEndpoint: () => Promise<InternalApiResponse> } => ({
  currentDate: '2026-11-17',
  locale: 'en-US',
  callEndpoint: async () => playlists,
} as never);

async function run(tool: ReturnType<typeof listTool>, maxResultChars?: number) {
  const aiTool = toolToAiTool(tool, context(), 'playlists_list', maxResultChars !== undefined ? { maxResultChars } : {});
  return await aiTool.execute({}) as { data: { items: unknown[]; page: number }; _truncated: Record<string, unknown> };
}

describe('maxResultChars precedence in toolToAiTool', () => {
  it('uses the default 16,000 without any option', async () => {
    const result = await run(listTool());
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_000);
    expect(result._truncated).toMatchObject({ field: 'data.items', total: 20 });
    expect(result.data.page).toBe(1);
  });

  it('uses the global option', async () => {
    const result = await run(listTool(), 100_000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000);
    expect(result._truncated.showing).toBeGreaterThanOrEqual(11);
  });

  it('lets the tool value win over the global option', async () => {
    const result = await run(listTool(200_000), 4_000);
    expect(result._truncated).toBeUndefined();
    expect(result.data.items).toHaveLength(20);
  });

  it('names the paging parameters of the tool in the hint', async () => {
    const result = await run(listTool());
    expect(result._truncated.hint).toContain('page, pageSize');
  });

  it('ignores an invalid tool value inside toolToAiTool and falls back to the global value', async () => {
    const tool = { ...listTool(), maxResultChars: 10 };
    const result = await run(tool, 100_000);
    expect(JSON.stringify(result).length).toBeGreaterThan(16_000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000);
  });

  it('offers paging only for a read tool (GET); a write tool is told not to call again', async () => {
    const read = await run(listTool());
    expect(read._truncated.hint).toContain('next page with the parameters page, pageSize');
    const write = endpointToolToTool(defineEndpointTool({
      id: 'playlists.import',
      toolName: 'playlists_import',
      description: 'Import playlists.',
      method: 'POST',
      path: '/api/playlists/import',
      inputSchema: z.object({ limit: z.number().optional() }).strict(),
    }));
    const written = await toolToAiTool(write, context(), 'playlists_import').execute({}) as typeof read;
    expect(written._truncated.hint).toContain('do not call it again just to see more');
    expect(written._truncated.hint).not.toContain('limit,');
    expect(written._truncated.hint).not.toContain('next page');
    const custom = defineTool({
      id: 'report.show', description: 'Show a report.', inputSchema: z.object({ page: z.number().optional() }),
      execute: async () => ({ rows: Array.from({ length: 50 }, (_, index) => ({ index, text: 'r'.repeat(1_000) })) }),
    });
    const customResult = await toolToAiTool(custom, context()).execute({}) as typeof read;
    expect(customResult._truncated.hint).toContain('parameters page');
    const approved = await toolToAiTool({ ...custom, needsApproval: true }, context()).execute({}) as typeof read;
    expect(approved._truncated.hint).toContain('do not call it again');
  });

  it('rejects an invalid tool value at definition time', () => {
    expect(() => listTool(10)).toThrow('maxResultChars must be an integer from 1000 to 200000');
  });
});

describe('maxResultChars on createAiChatHandler', () => {
  it('throws at creation for an invalid value', () => {
    for (const bad of [999, 200_001, 5_000.5]) {
      expect(() => createAiChatHandler({
        tools: { playlists_list: listTool() },
        model: textModel(),
        systemPrompt: 'Assistant',
        maxResultChars: bad,
      })).toThrow('createAiChatHandler: maxResultChars must be an integer from 1000 to 200000');
    }
  });

  const pipelineResult: PipelineResult = {
    model: { modelId: 'fixture' }, tools: ['playlists_list'], sanitizedInput: 'playlists',
    intent: { intent: 'ambiguous', confidence: 0 }, module: null, followupsEnabled: false,
  };

  it.each([
    ['legacy', false],
    ['pipeline', true],
  ] as const)('bounds a tool result in the %s path with the global value', async (_mode, withPipeline) => {
    let output: unknown;
    let processed = 0;
    const handler = createAiChatHandler({
      tools: { playlists_list: listTool() },
      model: textModel(),
      systemPrompt: 'Assistant',
      maxResultChars: 5_000,
      // PR F behaviour: without result handles a large result is cut.
      resultHandles: false,
      endpointCaller: () => async () => playlists,
      ...(withPipeline ? { pipeline: { process: async () => { processed += 1; return pipelineResult; } } } : {}),
      streamHandler: async (ctx) => {
        const tool = ctx.tools.playlists_list as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> };
        output = await tool.execute({}, { toolCallId: 'call-1', messages: [] });
        return new Response('ok');
      },
    });
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'playlists' }] }] }),
    }));
    expect(response.status).toBe(200);
    expect(processed).toBe(withPipeline ? 1 : 0);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(5_000);
    expect(output).toMatchObject({ _truncated: { field: 'data.items', total: 20 } });
  });

  it('bounds a direct command result with the global value', async () => {
    const command = formatChatCommandMessage({
      commandId: 'playlists.list', tool: 'playlists.list', args: {}, label: '/Playlists',
    });
    const outputOf = async (maxResultChars?: number) => {
      const handler = createAiChatHandler({
        tools: { playlists_list: listTool() },
        model: textModel(),
        systemPrompt: 'Assistant',
        endpointCaller: () => async () => playlists,
        ...(maxResultChars !== undefined ? { maxResultChars } : {}),
      });
      const chunks = await streamChunks(await handler(new Request('https://app.example/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: command }] }] }),
      })));
      return chunks.find((chunk) => chunk.type === 'tool-output-available')?.output as {
        _truncated?: { showing: number; total: number };
      };
    };
    const narrow = await outputOf(5_000);
    expect(JSON.stringify(narrow).length).toBeLessThanOrEqual(5_000);
    expect(narrow._truncated).toMatchObject({ total: 20 });
    const wide = await outputOf(200_000);
    expect(wide._truncated).toBeUndefined();
  });
});
