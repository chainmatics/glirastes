import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { prepareModelMessages, type ModelInputBreakdown } from '../prepare-model-messages.js';
import { HISTORY_TEXT_ONLY_NOTE } from '../history-compaction.js';

type Part = Record<string, unknown>;

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (id: string, parts: Part[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as UIMessage;
const toolPart = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output,
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const playlists = (count: number, offset = 0) => ({
  success: true,
  data: Array.from({ length: count }, (_, index) => ({ id: uuid(offset + index + 1), name: `Playlist ${offset + index + 1}` })),
});

/** A list turn, then `chats` turns without tools, then the current question. */
function conversation(chats: number): UIMessage[] {
  const messages: UIMessage[] = [
    user('u0', 'Show my playlists'),
    assistant('a0', [{ type: 'step-start' }, toolPart('playlists_list', 'c0', {}, playlists(5)), { type: 'text', text: 'Five playlists.' }]),
  ];
  for (let index = 1; index <= chats; index += 1) {
    messages.push(user(`u${index}`, `thanks ${index}`), assistant(`a${index}`, [{ type: 'text', text: `You are welcome ${index}.` }]));
  }
  messages.push(user('uq', 'Rename Playlist 3'));
  return messages;
}

function toolResultCount(messages: unknown[]): number {
  return (messages as Array<{ role: string }>).filter((message) => message.role === 'tool').length;
}

describe('history.toolTurnCounting', () => {
  it('all-turns (default): a turn without tools uses up the only slot, the list ids are gone', async () => {
    const messages = await prepareModelMessages(conversation(1));
    expect(JSON.stringify(messages)).not.toContain(uuid(3));
    expect(JSON.stringify(messages)).toContain(JSON.stringify(HISTORY_TEXT_ONLY_NOTE).slice(1, -1));
    expect(toolResultCount(messages)).toBe(0);
  });

  it('the default is byte-identical to an explicit all-turns', async () => {
    for (const chats of [0, 1, 3]) {
      const implicit = await prepareModelMessages(conversation(chats));
      const explicit = await prepareModelMessages(conversation(chats), { history: { toolTurnCounting: 'all-turns' } });
      expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
    }
  });

  it('tool-turns: turns without tools use up no slot, the list keeps its ids', async () => {
    const messages = await prepareModelMessages(conversation(3), { maxContextMessages: 60, history: { toolTurnCounting: 'tool-turns' } });
    const text = JSON.stringify(messages);
    expect(text).toContain(uuid(3));
    expect(toolResultCount(messages)).toBe(1);
    expect(text).toContain('thanks 3');
  });

  it('tool-turns equals all-turns when every earlier turn called a tool', async () => {
    const messages: UIMessage[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      messages.push(user(`u${turn}`, `list ${turn}`));
      messages.push(assistant(`a${turn}`, [{ type: 'step-start' }, toolPart('playlists_list', `c${turn}`, {}, playlists(3, turn * 3)), { type: 'text', text: 'Done.' }]));
    }
    messages.push(user('uq', 'and now?'));
    for (const toolTurns of [1, 2]) {
      const all = await prepareModelMessages(messages, { maxContextMessages: 60, history: { toolTurns } });
      const tools = await prepareModelMessages(messages, { maxContextMessages: 60, history: { toolTurns, toolTurnCounting: 'tool-turns' } });
      expect(JSON.stringify(tools)).toBe(JSON.stringify(all));
    }
  });

  it('tool-turns keeps only the newest toolTurns tool turns and notes the older ones', async () => {
    const messages: UIMessage[] = [
      user('u0', 'list A'), assistant('a0', [{ type: 'step-start' }, toolPart('playlists_list', 'c0', {}, playlists(2)), { type: 'text', text: 'Two.' }]),
      user('u1', 'thanks'), assistant('a1', [{ type: 'text', text: 'Welcome.' }]),
      user('u2', 'list B'), assistant('a2', [{ type: 'step-start' }, toolPart('playlists_list', 'c2', {}, playlists(2, 10)), { type: 'text', text: 'Two more.' }]),
      user('u3', 'thanks'), assistant('a3', [{ type: 'text', text: 'Welcome.' }]),
      user('uq', 'rename'),
    ];
    let breakdown: ModelInputBreakdown | undefined;
    const sent = await prepareModelMessages(messages, {
      maxContextMessages: 60,
      history: { toolTurnCounting: 'tool-turns' },
      onBreakdown: (value) => { breakdown = value; },
    });
    const text = JSON.stringify(sent);
    expect(text).toContain(uuid(11));
    expect(text).not.toContain(uuid(1));
    expect(breakdown!.turns.map((turn) => turn.mode)).toEqual(['text', 'text', 'compacted', 'text']);
    expect(breakdown!.turns.map((turn) => turn.hadToolCalls)).toEqual([true, false, true, false]);
    // The older list turn went as text: it carries the note that its ids are not available.
    expect(text).toContain('Tool results of this and earlier turns are left out');
  });

  it('tool-turns sends an older compacted turn as text before it leaves out a turn', async () => {
    const big = (offset: number) => ({ success: true, data: Array.from({ length: 30 }, (_, index) => ({ id: uuid(offset + index), name: `Entry ${offset + index} ${'x'.repeat(80)}` })) });
    const messages: UIMessage[] = [
      user('u0', 'first list'), assistant('a0', [{ type: 'step-start' }, toolPart('list', 'c0', {}, big(100)), { type: 'text', text: 'First.' }]),
      user('u1', 'second list'), assistant('a1', [{ type: 'step-start' }, toolPart('list', 'c1', {}, big(200)), { type: 'text', text: 'Second.' }]),
      user('uq', 'next'),
    ];
    let breakdown: ModelInputBreakdown | undefined;
    const sent = await prepareModelMessages(messages, {
      maxContextMessages: 60,
      history: { toolTurns: 2, toolTurnCounting: 'tool-turns', maxTokens: 2_000 },
      onBreakdown: (value) => { breakdown = value; },
    });
    expect(breakdown!.turns.map((turn) => turn.mode)).toEqual(['text', 'compacted']);
    expect(JSON.stringify(sent)).toContain('first list');
    // all-turns, as before: the turn that does not fit is left out as a whole.
    await prepareModelMessages(messages, {
      maxContextMessages: 60,
      history: { toolTurns: 2, maxTokens: 2_000 },
      onBreakdown: (value) => { breakdown = value; },
    });
    expect(breakdown!.turns.map((turn) => turn.mode)).toEqual(['left-out', 'compacted']);
  });

  it('reports the breakdown: modes, legacy pipeline and a token estimate', async () => {
    const breakdowns: ModelInputBreakdown[] = [];
    await prepareModelMessages(conversation(1), { onBreakdown: (value) => breakdowns.push(value) });
    await prepareModelMessages(conversation(1), { history: false, onBreakdown: (value) => breakdowns.push(value) });
    expect(breakdowns[0]).toMatchObject({
      pipeline: 'turn-aware',
      toolTurnCounting: 'all-turns',
      turns: [{ index: 0, mode: 'text', hadToolCalls: true }, { index: 1, mode: 'text', hadToolCalls: false }],
      earlierMessages: 0,
    });
    expect(breakdowns[0]!.estimatedTokens).toBeGreaterThan(0);
    expect(breakdowns[0]!.seenObjects).toBeUndefined();
    expect(breakdowns[1]).toMatchObject({ pipeline: 'legacy', turns: [] });
  });

  it('a throwing onBreakdown does not break the preparation', async () => {
    const sent = await prepareModelMessages(conversation(0), { onBreakdown: () => { throw new Error('boom'); } });
    expect(toolResultCount(sent)).toBe(1);
  });

  it('marks turns beyond maxTurns as left out', async () => {
    let breakdown: ModelInputBreakdown | undefined;
    await prepareModelMessages(conversation(3), { maxContextMessages: 60, history: { maxTurns: 2 }, onBreakdown: (value) => { breakdown = value; } });
    expect(breakdown!.turns.map((turn) => turn.mode)).toEqual(['left-out', 'left-out', 'text', 'text']);
  });
});
