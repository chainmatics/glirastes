import { convertToModelMessages, pruneMessages, type UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactToolOutput, prepareModelMessages } from '../prepare-model-messages.js';
import { sanitizeModelMessages } from '../sanitize-model-messages.js';

type Part = Record<string, unknown>;

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

const assistant = (id: string, parts: Part[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as UIMessage;

const toolPart = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output,
});

function tasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Aufgabe ${index + 1}: Quartalsbericht für Kunde ${index + 1} vorbereiten`,
    status: index % 3 === 0 ? 'done' : 'open',
    priority: index % 2 === 0 ? 'high' : 'normal',
    description: 'Details zur Aufgabe mit Kontext, Ansprechpartnern und den nächsten Schritten. '.repeat(4),
    assignee: { id: `user-${index % 5}`, name: `Person ${index % 5}` },
  }));
}

function toolCalls(messages: unknown[]) {
  return (messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'assistant' && Array.isArray(message.content))
    .flatMap((message) => (message.content as Part[]).filter((part) => part.type === 'tool-call'));
}

function toolResults(messages: unknown[]) {
  return (messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Part[]);
}

const estimateTokens = (messages: unknown[]) => Math.ceil(JSON.stringify(messages).length / 4);

describe('prepareModelMessages', () => {
  it('strips uiAction from AI SDK 6 json tool outputs', async () => {
    const messages = await prepareModelMessages([
      user('u1', 'Neue Aufgabe'),
      assistant('a1', [{ type: 'step-start' }, toolPart('tasks_create', 'c1', {}, { id: 't1', uiAction: { type: 'toast' } })]),
    ]);
    const [result] = toolResults(messages);
    expect(result).toMatchObject({ output: { type: 'json', value: { id: 't1' } } });
    expect(JSON.stringify(messages)).not.toContain('uiAction');
  });

  it('keeps the previous turn\'s tool call so a follow-up can repeat it', async () => {
    const filter = { status: 'open', priority: 'high', assignee: 'me' };
    const messages = await prepareModelMessages([
      user('u1', 'Nur meine offenen Aufgaben mit hoher Priorität'),
      assistant('a1', [
        { type: 'step-start' },
        toolPart('ui_tasks_filters_apply', 'c1', filter, { applied: true }),
        { type: 'step-start' },
        { type: 'text', text: 'Filter gesetzt.' },
      ]),
      user('u2', 'Zeig alle'),
      assistant('a2', [{ type: 'text', text: 'Alle Aufgaben.' }]),
      user('u3', 'bitte den Filter den wir eben hatten anwenden'),
    ]);
    // The filter turn is two turns back, so it is text-only now ...
    expect(toolCalls(messages)).toEqual([]);

    const followUp = await prepareModelMessages([
      user('u1', 'Nur meine offenen Aufgaben mit hoher Priorität'),
      assistant('a1', [
        { type: 'step-start' },
        toolPart('ui_tasks_filters_apply', 'c1', filter, { applied: true }),
        { type: 'step-start' },
        { type: 'text', text: 'Filter gesetzt.' },
      ]),
      user('u2', 'okay aber bitte wieder auf den Filter den wir eben hatten'),
    ]);
    // ... while the previous turn keeps its arguments.
    expect(toolCalls(followUp)).toEqual([
      expect.objectContaining({ toolName: 'ui_tasks_filters_apply', input: filter }),
    ]);
  });

  it('compacts large results of earlier turns and keeps the current turn complete', async () => {
    const messages = await prepareModelMessages([
      user('u1', 'Zeig alle Aufgaben'),
      assistant('a1', [{ type: 'step-start' }, toolPart('tasks_list', 'c1', {}, { tasks: tasks(50) }), { type: 'text', text: '50 Aufgaben.' }]),
      user('u2', 'Und die von Person 1?'),
      assistant('a2', [{ type: 'step-start' }, toolPart('tasks_list', 'c2', { assignee: 'user-1' }, { tasks: tasks(40) })]),
    ]);
    const [earlier, current] = toolResults(messages) as Array<{ output: { value: { tasks: unknown[] } } }>;
    expect(earlier!.output.value.tasks).toHaveLength(11);
    expect(earlier!.output.value.tasks[0]).toMatchObject({ id: 'task-1' });
    expect(earlier!.output.value.tasks[10]).toBe('[40 more items, 50 total]');
    expect(current!.output.value.tasks).toHaveLength(40);
  });

  it('sends older turns as text only and caps the number of earlier turns', async () => {
    const history: UIMessage[] = [];
    for (let turn = 1; turn <= 10; turn++) {
      history.push(user(`u${turn}`, `Frage ${turn}`));
      history.push(assistant(`a${turn}`, [
        { type: 'step-start' },
        toolPart('tasks_list', `c${turn}`, {}, { tasks: tasks(3) }),
        { type: 'step-start' },
        { type: 'text', text: `Antwort ${turn}` },
      ]));
    }
    history.push(user('u11', 'Frage 11'));
    const messages = await prepareModelMessages(history, {
      maxContextMessages: 100,
      history: { maxTurns: 4 },
    });
    const text = JSON.stringify(messages);
    expect(text).not.toContain('Frage 6');
    expect(text).toContain('Frage 7');
    expect(toolCalls(messages).map((call) => call.toolCallId)).toEqual(['c10']);
  });

  it('drops the oldest turns beyond the history token budget', async () => {
    const long = 'Sehr lange Antwort. '.repeat(400);
    const messages = await prepareModelMessages([
      user('u1', 'Erste'), assistant('a1', [{ type: 'text', text: long }]),
      user('u2', 'Zweite'), assistant('a2', [{ type: 'text', text: long }]),
      user('u3', 'Dritte'),
    ], { history: { maxTokens: 3000 } });
    const text = JSON.stringify(messages);
    expect(text).not.toContain('Erste');
    expect(text).toContain('Zweite');
    expect(text).toContain('Dritte');
  });

  it('keeps the legacy pipeline with history: false', async () => {
    const messages = await prepareModelMessages([
      user('u1', 'Zeig alle Aufgaben'),
      assistant('a1', [{ type: 'step-start' }, toolPart('tasks_list', 'c1', {}, { tasks: tasks(50) })]),
    ], { history: false });
    expect((toolResults(messages)[0] as { output: { value: { tasks: unknown[] } } }).output.value.tasks).toHaveLength(50);
  });

  it('measures the input-token reduction on a realistic multi-turn history', async () => {
    const history: UIMessage[] = [];
    const requests = [
      'Zeig mir alle offenen Aufgaben',
      'Welche davon haben hohe Priorität?',
      'Zeig die Aufgaben von Person 2',
      'Lege eine Aufgabe für den Quartalsbericht an',
      'Wer ist im Team Marketing?',
      'Filtere auf meine Aufgaben',
    ];
    requests.forEach((text, index) => {
      history.push(user(`u${index}`, text));
      history.push(assistant(`a${index}`, [
        { type: 'step-start' },
        toolPart('tasks_list', `c${index}`, { query: text }, { tasks: tasks(25), uiAction: { type: 'refresh' } }),
        { type: 'step-start' },
        { type: 'text', text: `Hier ist das Ergebnis zu „${text}“ mit einer kurzen Zusammenfassung der wichtigsten Punkte.` },
      ]));
    });
    history.push(user('u-now', 'bitte den Filter den wir eben hatten anwenden'));

    // Before: 12 UI messages, last 12 model messages, tool calls kept in the last 3 messages.
    const raw = await convertToModelMessages(history.slice(-12), { ignoreIncompleteToolCalls: true });
    const legacy = sanitizeModelMessages(pruneMessages({
      messages: raw.slice(-12),
      reasoning: 'none',
      toolCalls: 'before-last-3-messages',
      emptyMessages: 'remove',
    }));
    const current = await prepareModelMessages(history.slice(-12), { maxContextMessages: 12 });

    const before = estimateTokens(legacy);
    const after = estimateTokens(current);
    console.info(`history input tokens (estimated): before ${before}, after ${after}`);
    expect(after).toBeLessThan(before);
    // The previous turn's call (with its arguments) is still there.
    expect(toolCalls(current).map((call) => call.toolCallId)).toEqual(['c5']);
  });
});

it('measures the history budget on long earlier answers', async () => {
  const history: UIMessage[] = [];
  for (let turn = 0; turn < 6; turn++) {
    history.push(user(`u${turn}`, `Fasse Projekt ${turn} zusammen`));
    history.push(assistant(`a${turn}`, [
      { type: 'reasoning', text: 'Ich prüfe die Projektdaten und fasse sie zusammen. '.repeat(20) },
      { type: 'text', text: `Zusammenfassung ${turn}: ${'Ein ausführlicher Absatz mit Zahlen, Terminen und Risiken. '.repeat(40)}` },
    ]));
  }
  history.push(user('u-now', 'Und was davon ist am dringendsten?'));
  const raw = await convertToModelMessages(history.slice(-12), { ignoreIncompleteToolCalls: true });
  const legacy = sanitizeModelMessages(pruneMessages({
    messages: raw.slice(-12), reasoning: 'none', toolCalls: 'before-last-3-messages', emptyMessages: 'remove',
  }));
  const current = await prepareModelMessages(history.slice(-12), { maxContextMessages: 12 });
  const before = estimateTokens(legacy);
  const after = estimateTokens(current);
  console.info(`long-answer history input tokens (estimated): before ${before}, after ${after}`);
  expect(after).toBeLessThan(before * 0.75);
  expect(JSON.stringify(current)).toContain('Zusammenfassung 5');
});

describe('prepareModelMessages with long pasted text', () => {
  it('never drops the previous turn; an oversized text is cut to head and tail', async () => {
    const out = await prepareModelMessages([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: `START ${'Clause text. '.repeat(1500)}END` }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Got it.' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Summarize clause 3' }] },
    ] as UIMessage[], { maxContextMessages: 12 });
    const text = JSON.stringify(out);
    expect(text).toContain('Clause text');
    expect(text).toContain('START');
    expect(text).toContain('END');
    expect(text).toContain('characters omitted');
    expect(text).toContain('Got it.');
  });

  it('never cuts the current user message', async () => {
    const pasted = `START ${'Clause text. '.repeat(3000)}END`;
    const out = await prepareModelMessages([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi.' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: pasted }] },
    ] as UIMessage[]);
    expect(JSON.stringify(out)).toContain(JSON.stringify(pasted).slice(1, -1));
  });
});

describe('compactToolOutput', () => {
  it('is deterministic and keeps short values untouched', () => {
    const value = { id: 'a', list: [1, 2, 3], note: 'kurz' };
    expect(compactToolOutput(value)).toEqual(value);
    expect(compactToolOutput({ text: 'x'.repeat(1000) })).toEqual({ text: `${'x'.repeat(300)}… [700 more characters]` });
  });
});
