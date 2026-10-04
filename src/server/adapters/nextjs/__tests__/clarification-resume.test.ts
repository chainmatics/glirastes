import { describe, expect, it } from 'vitest';
import { formatClarificationAnswer } from '../../../../contracts/clarification.js';
import {
  applyClarificationResume,
  resolveClarificationResume,
} from '../clarification-resume.js';

function clarificationTurn(toolCallId: string, question: string) {
  return {
    id: `assistant-${toolCallId}`,
    role: 'assistant',
    parts: [{
      type: 'tool-ask_clarification',
      toolCallId,
      state: 'output-available',
      input: { question, target: 'object', options: [], allowFreeText: true },
      output: { success: true },
    }],
  };
}

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('clarification resume', () => {
  it('joins the original request, the question and the answer', () => {
    const messages = [
      user('u1', 'Lösche die Aufgabe'),
      clarificationTurn('call-1', 'Welche Aufgabe?'),
      user('u2', formatClarificationAnswer({
        toolCallId: 'call-1', optionId: 'task-1', answer: 'Bericht schreiben',
      })),
    ];
    const resume = resolveClarificationResume(messages)!;
    expect(resume).toMatchObject({
      originalRequest: 'Lösche die Aufgabe',
      question: 'Welche Aufgabe?',
      answer: 'Bericht schreiben',
      optionId: 'task-1',
      routingText: 'Lösche die Aufgabe\nWelche Aufgabe? Bericht schreiben',
      answerMessageIndex: 2,
    });
    const rewritten = applyClarificationResume(messages, resume);
    expect(rewritten[0]).toBe(messages[0]);
    expect(rewritten[2]).toEqual({
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: resume.modelText }],
    });
    expect(resume.modelText).toContain('Original request: Lösche die Aufgabe');
    expect(JSON.stringify(messages[2])).toContain('glirastes:clarification');
  });

  it('follows chained clarifications back to the first request', () => {
    const messages = [
      user('u1', 'Weise die Aufgabe zu'),
      clarificationTurn('call-1', 'Welche Aufgabe?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'Release prüfen' })),
      clarificationTurn('call-2', 'Wem?'),
      user('u3', formatClarificationAnswer({ toolCallId: 'call-2', answer: 'Alice' })),
    ];
    expect(resolveClarificationResume(messages)?.routingText).toBe(
      'Weise die Aufgabe zu\nWelche Aufgabe? Release prüfen\nWem? Alice',
    );
  });

  it.each([
    ['a plain message', [user('u1', 'Hallo')]],
    ['an unknown tool call id', [
      user('u1', 'Lösche'),
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-9', answer: 'x' })),
    ]],
    ['an answer without an original request', [
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'x' })),
    ]],
    ['a marker on an older message only', [
      user('u1', 'Lösche'),
      clarificationTurn('call-1', 'Welche?'),
      user('u2', formatClarificationAnswer({ toolCallId: 'call-1', answer: 'x' })),
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Erledigt.' }] },
      user('u3', 'Neue Frage'),
    ]],
  ])('does not resume for %s', (_label, messages) => {
    expect(resolveClarificationResume(messages)).toBeUndefined();
  });
});
