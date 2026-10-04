import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_MAX_LABEL_LENGTH,
  CLARIFICATION_MAX_OPTIONS,
  CLARIFICATION_MAX_QUESTION_LENGTH,
  formatClarificationAnswer,
} from '../../../contracts/clarification.js';
import {
  findOpenClarification,
  isClarificationAnswered,
  readClarificationPart,
} from '../clarification.js';

function toolPart(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool-ask_clarification',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: 'Wen meinst du?' },
    output: { success: true },
    ...overrides,
  };
}

describe('readClarificationPart', () => {
  it('ignores parts that are not an answerable clarification', () => {
    expect(readClarificationPart(undefined)).toBeUndefined();
    expect(readClarificationPart({ type: 'text', text: 'hi' })).toBeUndefined();
    expect(readClarificationPart(toolPart({ type: 'tool-list_tasks' }))).toBeUndefined();
    expect(readClarificationPart(toolPart({ toolCallId: undefined }))).toBeUndefined();
    expect(readClarificationPart(toolPart({ input: { question: '   ' } }))).toBeUndefined();
  });

  it('reads dynamic tool parts and prefers the stored output over the input', () => {
    const part = readClarificationPart({
      type: 'dynamic-tool',
      toolName: 'ask_clarification',
      toolCallId: 'call-2',
      state: 'output-available',
      input: { question: 'Aus dem Input?' },
      output: { clarification: { question: 'Aus dem Output?', target: 'time', options: [] } },
    });
    expect(part).toEqual({
      toolCallId: 'call-2',
      ready: true,
      request: { question: 'Aus dem Output?', target: 'time', options: [], allowFreeText: true },
    });
  });

  it('is not ready before the tool output exists', () => {
    expect(readClarificationPart(toolPart({ state: 'input-available' }))?.ready).toBe(false);
  });

  it('bounds and sanitizes the request with the shared contract limits', () => {
    const options = [
      { id: 'bad id', label: 'dropped: invalid id' },
      { id: 'a', label: 'x'.repeat(CLARIFICATION_MAX_LABEL_LENGTH + 20), description: '  ' },
      { id: 'a', label: 'dropped: duplicate id' },
      { id: 'b', label: '   ' },
      ...Array.from({ length: CLARIFICATION_MAX_OPTIONS + 3 }, (_, index) => (
        { id: `o${index}`, label: `Option ${index}` }
      )),
    ];
    const part = readClarificationPart(toolPart({
      input: {
        question: 'q'.repeat(CLARIFICATION_MAX_QUESTION_LENGTH + 50),
        target: 'nonsense',
        options,
        allowFreeText: false,
      },
    }));

    expect(part?.request.question).toHaveLength(CLARIFICATION_MAX_QUESTION_LENGTH);
    expect(part?.request.target).toBe('other');
    // Only the first CLARIFICATION_MAX_OPTIONS candidates are considered.
    expect(part?.request.options.map((option) => option.id)).toEqual(['a', 'o0', 'o1']);
    expect(part?.request.options[0]).toEqual({
      id: 'a',
      label: 'x'.repeat(CLARIFICATION_MAX_LABEL_LENGTH),
    });
    expect(part?.request.allowFreeText).toBe(false);
  });

  it('keeps free text available when no usable option survives', () => {
    const part = readClarificationPart(toolPart({
      input: { question: 'Was genau?', options: [{ id: 'bad id', label: 'x' }], allowFreeText: false },
    }));
    expect(part?.request.options).toEqual([]);
    expect(part?.request.allowFreeText).toBe(true);
  });
});

describe('findOpenClarification', () => {
  const assistant = (parts: unknown[]) => ({ role: 'assistant', parts });

  it('returns the last answerable clarification of the latest assistant message', () => {
    const open = findOpenClarification([
      { role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }] },
      assistant([
        toolPart({ toolCallId: 'call-1' }),
        toolPart({ toolCallId: 'call-2' }),
        toolPart({ toolCallId: 'call-3', state: 'input-available' }),
      ]),
    ]);
    expect(open?.toolCallId).toBe('call-2');
  });

  it('is undefined when a user message follows or nothing is answerable yet', () => {
    expect(findOpenClarification([])).toBeUndefined();
    expect(findOpenClarification([
      assistant([toolPart()]),
      { role: 'user', parts: [{ type: 'text', text: 'Alice' }] },
    ])).toBeUndefined();
    expect(findOpenClarification([assistant([toolPart({ state: 'input-streaming' })])]))
      .toBeUndefined();
  });
});

describe('isClarificationAnswered', () => {
  const marker = (toolCallId: string) => formatClarificationAnswer({ toolCallId, answer: 'Alice' });

  it('detects an answer marker for that tool call in a user message', () => {
    const messages = [{ role: 'user', parts: [{ type: 'text', text: marker('call-1') }] }];
    expect(isClarificationAnswered(messages, 'call-1')).toBe(true);
    expect(isClarificationAnswered(messages, 'call-2')).toBe(false);
  });

  it('ignores markers outside user text parts', () => {
    expect(isClarificationAnswered([
      { role: 'assistant', parts: [{ type: 'text', text: marker('call-1') }] },
      { role: 'user', parts: [{ type: 'tool-x', text: marker('call-1') }, 'call-1'] },
    ], 'call-1')).toBe(false);
  });
});
