import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';

/** Deterministic transport fixture, NOT a shipped model or intent router. */
export function testModel() {
  if (process.env.GLIRASTES_REFERENCE_TEST_MODE !== '1') throw new Error('Reference test mode is required');
  return new MockLanguageModelV3({ doStream: async ({ prompt, tools }) => {
    const last = prompt.at(-1);
    const text = last?.role === 'user' ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
    let toolName;
    let input;
    if (text === 'Go to overview') { toolName = 'ui_navigate'; input = { view: 'overview' }; }
    else if (text === 'Filter done tasks') { toolName = 'ui_filter'; input = { view: 'tasks', filters: { status: 'done' } }; }
    else if (text === 'Show done tasks') { toolName = tools.find((tool) => tool.name.startsWith('query_'))?.name; input = { status: 'done' }; }
    const chunks = [{ type: 'stream-start', warnings: [] }];
    if (toolName) chunks.push({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
    else chunks.push({ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Reference response complete.' }, { type: 'text-end', id: 'answer' });
    chunks.push({ type: 'finish', finishReason: { unified: toolName ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
    return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
  } });
}
