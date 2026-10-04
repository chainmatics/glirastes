import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_MAX_ANSWER_LENGTH,
  CLARIFICATION_MAX_DESCRIPTION_LENGTH,
  CLARIFICATION_MAX_LABEL_LENGTH,
  CLARIFICATION_MAX_OPTIONS,
  CLARIFICATION_MAX_QUESTION_LENGTH,
  CLARIFICATION_OPTION_ID_PATTERN,
  CLARIFICATION_TARGETS,
  CLARIFICATION_TOOL_NAME,
  formatClarificationAnswer,
  parseClarificationAnswer,
  stripClarificationMarkers,
} from '../clarification.js';

describe('clarification answer protocol', () => {
  it('round-trips the tool call reference and the visible answer', () => {
    const text = formatClarificationAnswer({
      toolCallId: 'call_1', optionId: 'task-42', answer: '  Bericht schreiben ',
    });
    expect(text).toBe(
      '<!--glirastes:clarification {"toolCallId":"call_1","optionId":"task-42"}-->\nBericht schreiben',
    );
    expect(parseClarificationAnswer(text)).toEqual({
      reference: { toolCallId: 'call_1', optionId: 'task-42' },
      answer: 'Bericht schreiben',
    });
    expect(stripClarificationMarkers(text)).toBe('Bericht schreiben');
    expect(CLARIFICATION_TOOL_NAME).toBe('ask_clarification');
  });

  it('keeps free-text answers without an option id', () => {
    const text = formatClarificationAnswer({ toolCallId: 'call-2', answer: 'Alice' });
    expect(parseClarificationAnswer(`Prefix ${text}`)).toEqual({
      reference: { toolCallId: 'call-2' },
      answer: 'Prefix Alice',
    });
  });

  it.each([
    '<!--glirastes:clarification {"toolCallId":"call 1"}-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1","extra":true}-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1","optionId":"<b>"}-->\nx',
    '<!--glirastes:clarification not-json-->\nx',
    '<!--glirastes:clarification {"toolCallId":"call-1"}-->\n   ',
    'plain text',
  ])('ignores malformed or empty markers: %s', (text) => {
    expect(parseClarificationAnswer(text)).toBeUndefined();
  });

  it('rejects ids that could break the marker', () => {
    expect(() => formatClarificationAnswer({ toolCallId: 'a-->', answer: 'x' })).toThrow();
    expect(() => formatClarificationAnswer({ toolCallId: 'a', optionId: 'x y', answer: 'x' })).toThrow();
    expect(() => formatClarificationAnswer({ toolCallId: 'a', answer: '  ' })).toThrow();
  });
});

describe('clarification shared option limits', () => {
  it('exposes the limits the server schema and the chat UI validate against', () => {
    expect({
      targets: CLARIFICATION_TARGETS,
      maxOptions: CLARIFICATION_MAX_OPTIONS,
      maxQuestion: CLARIFICATION_MAX_QUESTION_LENGTH,
      maxLabel: CLARIFICATION_MAX_LABEL_LENGTH,
      maxDescription: CLARIFICATION_MAX_DESCRIPTION_LENGTH,
      maxAnswer: CLARIFICATION_MAX_ANSWER_LENGTH,
    }).toEqual({
      targets: ['person', 'object', 'time', 'scope', 'other'],
      maxOptions: 6,
      maxQuestion: 300,
      maxLabel: 120,
      maxDescription: 200,
      maxAnswer: 1_000,
    });
  });

  it('uses one option id pattern for the answer marker and for option validation', () => {
    for (const valid of ['task-42', 'a', 'user:7', 'v1.2_final', 'x'.repeat(64)]) {
      expect(CLARIFICATION_OPTION_ID_PATTERN.test(valid), valid).toBe(true);
      expect(
        parseClarificationAnswer(
          formatClarificationAnswer({ toolCallId: 'c1', optionId: valid, answer: 'ok' }),
        )?.reference.optionId,
      ).toBe(valid);
    }
    for (const invalid of ['', 'x y', '<b>', 'a-->', 'x'.repeat(65)]) {
      expect(CLARIFICATION_OPTION_ID_PATTERN.test(invalid), invalid).toBe(false);
      expect(() => formatClarificationAnswer({ toolCallId: 'c1', optionId: invalid, answer: 'ok' }))
        .toThrow('Invalid clarification option id');
    }
  });

  it('is stateless across repeated tests of the shared pattern', () => {
    expect(CLARIFICATION_OPTION_ID_PATTERN.global).toBe(false);
    expect(CLARIFICATION_OPTION_ID_PATTERN.sticky).toBe(false);
  });

  it('truncates answers to the shared limit and strips every marker', () => {
    const long = 'a'.repeat(CLARIFICATION_MAX_ANSWER_LENGTH + 50);
    const text = formatClarificationAnswer({ toolCallId: 'c1', answer: long });
    expect(parseClarificationAnswer(text)?.answer).toHaveLength(CLARIFICATION_MAX_ANSWER_LENGTH);
    const twice = `${formatClarificationAnswer({ toolCallId: 'c1', answer: 'one' })}\n`
      + formatClarificationAnswer({ toolCallId: 'c2', answer: 'two' });
    expect(stripClarificationMarkers(twice)).toBe('one\ntwo');
    expect(parseClarificationAnswer(twice)?.reference.toolCallId).toBe('c1');
  });
});
