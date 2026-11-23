import { describe, expect, it } from 'vitest';
import { generateText, streamText, type UIMessageChunk } from 'ai';
import { BLOCKED_ATTACHMENTS } from '../attachment-policy.js';
import { PrivacyError } from '../detection-result.js';
import { privacyStatusData, privacyStreamErrorText, projectUiMessageStream } from '../display-projection.js';
import { createPrivacyBoundary } from '../model-boundary.js';
import { CANARY, CANARY_PATTERN, captureModel, memoryShield, testScope } from './privacy-fixtures.js';

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

async function protectedSession() {
  const shield = memoryShield();
  const scope = testScope();
  const session = await shield.open(scope);
  await session.registerIdentities([{ id: CANARY.userId, name: CANARY.name, email: CANARY.email }]);
  return { shield, scope, session };
}

describe('display projection', () => {
  it('rehydrates a pseudonym split across deltas, for the scope principal only', async () => {
    const { session } = await protectedSession();
    const fake = await session.pseudonymizeText(CANARY.name);
    const cut = Math.floor(fake.length / 2);
    const chunks = await collect(projectUiMessageStream(streamOf([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: `Hallo ${fake.slice(0, cut)}` },
      { type: 'text-delta', id: 't1', delta: `${fake.slice(cut)}!` },
      { type: 'text-end', id: 't1' },
    ]), session));
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('');
    expect(text).toBe(`Hallo ${CANARY.name}!`);
  });

  it('sends the content-free privacy status first', async () => {
    const { session } = await protectedSession();
    const status = privacyStatusData(session, BLOCKED_ATTACHMENTS, { providerLabel: 'Standard' });
    const chunks = await collect(projectUiMessageStream(streamOf([{ type: 'start' }]), session, { status }));
    expect(chunks[0]).toEqual({
      type: 'data-privacy-status',
      transient: true,
      data: { profile: 'protected-text/v1', text: 'protected', screenshots: 'blocked', label: 'Text geschützt; Screenshots sind gesperrt', provider: 'Standard' },
    });
  });

  it('drops partial tool input and rehydrates the complete input', async () => {
    const { session } = await protectedSession();
    const fakeEmail = await session.pseudonymizeText(CANARY.email);
    const chunks = await collect(projectUiMessageStream(streamOf([
      { type: 'tool-input-start', toolCallId: 'c', toolName: 'send' },
      { type: 'tool-input-delta', toolCallId: 'c', inputTextDelta: `{"to":"${fakeEmail}` },
      { type: 'tool-input-available', toolCallId: 'c', toolName: 'send', input: { to: fakeEmail } },
    ]), session));
    expect(chunks.map((c) => c.type)).toEqual(['tool-input-start', 'tool-input-available']);
    expect((chunks[1] as { input: unknown }).input).toEqual({ to: CANARY.email });
  });

  it('never releases an unfinished text part and masks error text', async () => {
    const { session } = await protectedSession();
    const chunks = await collect(projectUiMessageStream(streamOf([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'unfertig' },
      { type: 'error', errorText: `Provider said: ${CANARY.email}` },
    ]), session));
    expect(chunks).toEqual([{ type: 'text-start', id: 't' }, { type: 'error', errorText: 'AI request failed' }]);
    expect(privacyStreamErrorText(new PrivacyError('privacy_output_leak'))).toBe('privacy_output_leak');
    expect(privacyStreamErrorText(new Error(CANARY.email))).toBe('AI request failed');
  });
});

describe('protected history stays separate from display', () => {
  it('a later turn re-protects displayed history: the model never sees the originals the UI showed', async () => {
    const { shield, scope, session } = await protectedSession();
    // Turn 1: the model answers with a pseudonym; the UI shows the original.
    const fake = await session.pseudonymizeText(CANARY.name);
    const first = captureModel([{ text: `Ich habe ${fake} informiert.` }]);
    const turn1 = await generateText({ model: createPrivacyBoundary({ session }).wrapModel(first.model), prompt: `Informiere ${CANARY.name}` });
    const displayed = session.rehydrateText(turn1.text);
    expect(displayed).toBe(`Ich habe ${CANARY.name} informiert.`);

    // Turn 2 (new request, fresh session from the store): the browser sends back what it displayed.
    const session2 = await shield.open(scope);
    const second = captureModel([{ text: 'Ok.' }]);
    await generateText({
      model: createPrivacyBoundary({ session: session2 }).wrapModel(second.model),
      messages: [
        { role: 'user', content: `Informiere ${CANARY.name}` },
        { role: 'assistant', content: displayed },
        { role: 'user', content: 'Danke' },
      ],
    });
    const wire = JSON.stringify(second.calls);
    expect(wire).not.toMatch(CANARY_PATTERN);
    // The same original maps to the same pseudonym across turns.
    expect(wire).toContain(fake);
  });

  it('another conversation or principal cannot rehydrate this history', async () => {
    const { shield, scope, session } = await protectedSession();
    const masked = await session.pseudonymizeText(`Mail ${CANARY.email}`);
    for (const other of [{ ...scope, principalId: 'intruder' }, { ...scope, conversationId: 'conv-other' }, { ...scope, tenantId: 'tenant-x' }]) {
      const foreign = await shield.open(other);
      expect(foreign.rehydrateText(masked)).toBe(masked);
    }
  });

  it('a deleted conversation mapping cannot be reopened', async () => {
    const { shield, scope } = await protectedSession();
    await shield.deleteMapping(scope);
    await expect(shield.open(scope)).rejects.toMatchObject({ code: 'privacy_mapping_deleted' });
  });

  it('a streamed protected turn keeps pseudonyms in the server-side result', async () => {
    const { session } = await protectedSession();
    const fake = await session.pseudonymizeText(CANARY.email);
    const { model } = captureModel([{ text: `Gesendet an ${fake}` }]);
    const result = streamText({ model: createPrivacyBoundary({ session }).wrapModel(model), prompt: 'x' });
    const serverSide = await result.text;
    expect(serverSide).toBe(`Gesendet an ${fake}`);
    expect(serverSide).not.toMatch(CANARY_PATTERN);
  });
});
