import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import type { ToolRegistry } from '../../../../types.js';
import { uiActionToolToTool } from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A model that opens the delete dialog once, then answers with text. */
function dialogModel() {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1;
      return {
        stream: convertArrayToReadableStream((call === 1
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'ui_taskDeleteDialog_open', input: JSON.stringify({ taskId: 't1' }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]) as never),
      };
    },
  });
}

const registry: ToolRegistry = {
  ui_taskDeleteDialog_open: uiActionToolToTool({
    id: 'ui.taskDeleteDialog.open',
    toolName: 'ui_taskDeleteDialog_open',
    description: 'Open the delete dialog of a task.',
    inputSchema: createJsonSchemaLike({ type: 'object' }),
    needsApproval: false,
    action: { kind: 'client-action', actionId: 'task-delete-dialog.open' },
  }),
};

function post(body: Record<string, unknown>): Request {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösch die Aufgabe' }] }], ...body }),
  });
}

async function toolOutput(body: Record<string, unknown>) {
  const handler = createAiChatHandler({ tools: registry, model: dialogModel(), systemPrompt: 'Assistant' });
  const chunks = await streamChunks(await handler(post(body)));
  return chunks.find((chunk) => chunk.type === 'tool-output-available')?.output as Record<string, unknown>;
}

describe('client actions the page reports with the request', () => {
  it('refuses a client action the open page has no handler for', async () => {
    await expect(toolOutput({ glirastesClientActions: ['task-details.open'] })).resolves.toMatchObject({ success: false });
  });

  it('runs a client action the open page handles', async () => {
    await expect(toolOutput({ glirastesClientActions: ['task-delete-dialog.open'] })).resolves.toMatchObject({ success: true });
  });

  it('ignores a malformed report and keeps the previous behavior', async () => {
    await expect(toolOutput({ glirastesClientActions: 'task-details.open' })).resolves.toMatchObject({ success: true });
    await expect(toolOutput({})).resolves.toMatchObject({ success: true });
  });
});
