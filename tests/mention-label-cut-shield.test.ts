/**
 * A mention label is cut in the browser (`canonicalMentionLabel`, at most
 * 120 code points and `…`) and the PII shield only runs on the server,
 * over the sent text. A value that the cut splits (an email, IBAN or phone
 * number that starts shortly before the edge) must not reach the model as
 * a fragment the shield no longer recognises. Before 0.24.2 the label was
 * sent whole; `labels: 'raw'` writes that format.
 */
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { canonicalMentionLabel } from '../src/contracts/mention-marker.js';
import { sanitizeViewContext } from '../src/contracts/view-context.js';
import type { MentionSerializationConfig } from '../src/react/types.js';
import { serializeMentionsForSend } from '../src/react/utils/mention-markup.js';
import { createAiChatHandler } from '../src/server/adapters/nextjs/create-ai-chat-handler.js';
import { createPiiShield, createRegexPiiDetector } from '../src/server/pii-shield/index.js';

/** Values the regex detector finds whole (German locale for phone numbers). */
const VALUES = {
  email: 'max.mustermann@kanzlei-wendt.de',
  iban: 'DE89370400440532013000',
  'iban with spaces': 'DE89 3704 0044 0532 0130 00',
  'phone +49 with spaces': '+49 170 1234567',
  'phone +49 compact': '+491701234567',
  'phone national': '0170 1234567',
  'phone with slash': '030/12345678',
  'phone with parentheses': '+49 (30) 1234 5678',
  url: 'https://crm.kundenportal.de/kunden/4711?token=abcdef',
} as const;

const FILLER = 'Kunde Muster GmbH Ansprechpartner Herr Beispiel Vertrag Nummer sieben Notiz zum Fall bitte zurückrufen wegen Rechnung offen und so weiter ';

/** A label whose value starts at code point `offset` (all filler is BMP, so units = code points). */
function labelWith(value: string, offset: number): string {
  return `${FILLER.slice(0, offset - 1)} ${value} Ende der Notiz mit weiterem Text dahinter`;
}

/** The longest part (6+ characters) of `value` found in `text`; the scheme of a URL alone does not count. */
function fragmentOf(value: string, text: string): string {
  const secret = value.replace(/^https?:\/\//, '');
  for (let length = secret.length; length >= 6; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const part = secret.slice(start, start + length);
      if (text.includes(part)) return part;
    }
  }
  return '';
}

function shield() {
  return createPiiShield({ detector: createRegexPiiDetector(), locale: 'de-DE' });
}

function send(label: string, options?: MentionSerializationConfig): string {
  const mention = { id: 'c-1', type: 'customer', label, displayName: label, slug: 'kunde', prefix: '@' };
  return serializeMentionsForSend('Bitte prüfe @kunde', [mention], options);
}

/** `value` × offset 90-125 → the fragment the model gets, if any. */
async function leaks(options?: MentionSerializationConfig): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for (const [kind, value] of Object.entries(VALUES)) {
    for (let offset = 90; offset <= 125; offset += 1) {
      const modelText = await shield().outbound(send(labelWith(value, offset), options), 's');
      const fragment = fragmentOf(value, modelText);
      if (fragment) (found[kind] ??= []).push(`${offset}: ${fragment}`);
    }
  }
  return found;
}

describe('mention label cut before the PII shield', () => {
  it('cuts the labels of the matrix (the offsets are at the edge)', () => {
    for (const value of Object.values(VALUES)) {
      expect(canonicalMentionLabel(labelWith(value, 90)).endsWith('…')).toBe(true);
    }
  });

  it('sends no fragment of a value the cut splits (canonical labels, the default)', async () => {
    expect(await leaks()).toEqual({});
  });

  it('sends the fragments of 0.24.2 with labelCut grapheme, the switch back', async () => {
    const found = await leaks({ labelCut: 'grapheme' });
    expect(found.email).toContain('108: max.musterm');
    expect(found.iban).toContain('110: DE8937040');
    expect(found['phone +49 with spaces']).toContain('110: +49 170 1');
    expect(found['iban with spaces']).toContain('105: DE89 3704 0044');
  });

  it('sends no fragment with raw labels, the format before 0.24.2', async () => {
    expect(await leaks({ labels: 'raw' })).toEqual({});
  });

  it('writes raw labels as 0.24.1 did: the label as given', () => {
    const label = labelWith(VALUES.email, 108);
    expect(send(label, { labels: 'raw' })).toBe(`Bitte prüfe {{mention:customer:c-1:${label}}}`);
  });

  it('sends ordinary labels byte-identical to 0.24.2 (difference probe, 50 000 seeded labels)', () => {
    const words = ['Kunde', 'Müller-Lüdenscheidt', "O'Brien", '(GmbH)', '&', 'Straße,', 'zurück.', '—', '😀', '東京', 'नमस्ते', 'Rechnung', 'offen'];
    let state = 0x5eed;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };
    let cut = 0;
    for (let run = 0; run < 50_000; run += 1) {
      const count = 1 + Math.floor(next() * 45);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(words[Math.floor(next() * words.length)]!);
      const label = parts.join(' ');
      const sent = send(label, { includeContextBlock: true });
      if (sent.includes('…')) cut += 1;
      expect(sent).toBe(send(label, { includeContextBlock: true, labelCut: 'grapheme' }));
    }
    expect(cut).toBeGreaterThan(15_000);
  }, 60_000);

  it('leaves the view context label as before: the 0.24.2 cut at 60 code points (its fix is shielding before the cut)', () => {
    for (const value of Object.values(VALUES)) {
      for (let offset = 30; offset <= 65; offset += 1) {
        const label = labelWith(value, offset);
        const { entries } = sanitizeViewContext([{ entity: { type: 'customer', id: 'c-1' }, label }], { declaredTypes: ['customer'] });
        expect(entries[0]?.label).toBe(canonicalMentionLabel(label, { maxLength: 60, cut: 'grapheme' }));
      }
    }
  });

  it('keeps the fragment out of the model prompt through the chat handler', async () => {
    const prompts: unknown[] = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Ok.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ] as never),
        };
      },
    });
    const handler = createAiChatHandler({ model, tools: {}, systemPrompt: 'A.', intentRouting: false, piiShield: shield() } as never);
    const texts = [labelWith(VALUES.email, 108), labelWith(VALUES.iban, 110), labelWith(VALUES['phone +49 with spaces'], 110)];
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: texts.map((label) => send(label)).join('\n') }] }] }),
    }));
    await response.text();
    const prompt = JSON.stringify(prompts);
    expect(prompt).toContain('{{mention:customer:c-1:');
    expect(fragmentOf(VALUES.email, prompt)).toBe('');
    expect(fragmentOf(VALUES.iban, prompt)).toBe('');
    expect(fragmentOf(VALUES['phone +49 with spaces'], prompt)).toBe('');
  });
});
