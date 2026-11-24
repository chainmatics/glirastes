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
import type { PiiAuditEntry } from '../src/types.js';

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

/** Example IBANs of the IBAN countries (grouped as printed); the detector has one pattern for all of them. */
const IBANS = [
  'AL47 2121 1009 0000 0002 3569 8741', 'AD12 0001 2030 2003 5910 0100', 'AT61 1904 3002 3457 3201',
  'BE68 5390 0754 7034', 'BA39 1290 0794 0102 8494', 'BG80 BNBG 9661 1020 3456 78', 'HR12 1001 0051 8630 0016 0',
  'CY17 0020 0128 0000 0012 0052 7600', 'CZ65 0800 0000 1920 0014 5399', 'DK50 0040 0440 1162 43',
  'EE38 2200 2210 2014 5685', 'FI21 1234 5600 0007 85', 'FR14 2004 1010 0505 0001 3M02 606',
  'DE89 3704 0044 0532 0130 00', 'GI75 NWBK 0000 0000 7099 453', 'GR16 0110 1250 0000 0001 2300 695',
  'HU42 1177 3016 1111 1018 0000 0000', 'IS14 0159 2600 7654 5510 7303 39', 'IE29 AIBK 9311 5212 3456 78',
  'IT60 X054 2811 1010 0000 0123 456', 'LV80 BANK 0000 4351 9500 1', 'LI21 0881 0000 2324 013A A',
  'LT12 1000 0111 0100 1000', 'LU28 0019 4006 4475 0000', 'MT84 MALT 0110 0001 2345 MTLC AST0 01S',
  'MC58 1122 2000 0101 2345 6789 030', 'NL91 ABNA 0417 1643 00', 'NO93 8601 1117 947',
  'PL61 1090 1014 0000 0712 1981 2874', 'PT50 0002 0123 1234 5678 9015 4', 'RO49 AAAA 1B31 0075 9384 0000',
  'SM86 U032 2509 8000 0000 0270 100', 'SK31 1200 0000 1987 4263 7541', 'SI56 2633 0001 2039 086',
  'ES91 2100 0418 4502 0005 1332', 'SE45 5000 0000 0583 9825 7466', 'CH93 0076 2011 6238 5295 7',
  'GB29 NWBK 6016 1331 9268 19', 'SA03 8000 0000 6080 1016 7519', 'TR33 0006 1005 1978 6457 8413 26',
  'BR18 0036 0305 0000 1000 9795 493P 1', 'KW81 CBKU 0000 0000 0000 1234 5601 01', 'QA58 DOHB 0000 1234 5678 90AB CDEF G',
];

/** The sent text with every span the shield pseudonymizes blanked out: what reaches the model in plain text. */
async function plainAfterShield(sent: string): Promise<string> {
  const audits: PiiAuditEntry[] = [];
  const piiShield = createPiiShield({ detector: createRegexPiiDetector(), locale: 'de-DE', onAudit: (entry) => audits.push(entry) });
  await piiShield.outbound(sent, 's');
  let plain = sent;
  for (const { position } of audits.flatMap((entry) => entry.detections)) {
    plain = plain.slice(0, position.start) + '\u0000'.repeat(position.end - position.start) + plain.slice(position.end);
  }
  return plain;
}

/** Offsets 70-130 at which a fragment (6+ characters) of `value` reaches the model. */
async function leakOffsets(value: string, options?: MentionSerializationConfig): Promise<number[]> {
  const offsets: number[] = [];
  for (let offset = 70; offset <= 130; offset += 1) {
    if (fragmentOf(value, await plainAfterShield(send(labelWith(value, offset), options)))) offsets.push(offset);
  }
  return offsets;
}

/** Values of every kind the regex detector knows (German locale), each recognised whole by it. */
const ALL_VALUES = [
  ...IBANS, ...IBANS.map((iban) => iban.replace(/ /g, '')),
  'max.mustermann@kanzlei-wendt.de', '<max@kanzlei-wendt.de>',
  '+49 170 1234567', '+491701234567', '0049 170 1234567', '+49 (30) 1234 5678', '+49-30-12345678', '0170 1234567',
  '030/12345678', '030 1234 5678', '0221.123456', '089-1234567',
  'https://crm.kundenportal.de/kunden/4711?token=abcdef', '192.168.178.21', '24.12.1985', '12/345/67890',
];

/**
 * IBANs the detector's pattern does not match even whole (a detector
 * limit; `src/server/pii-shield` is out of scope here): Norway (15
 * characters, fewer than three groups of 4 after the check digits) and
 * compact IBANs whose length after the check digits is 3 more than a
 * multiple of 4.
 */
const DETECTOR_MISSES = [
  'NO93 8601 1117 947',
  'FR1420041010050500013M02606', 'GI75NWBK000000007099453', 'GR1601101250000000012300695', 'IT60X0542811101000000123456',
  'MT84MALT011000012345MTLCAST001S', 'MC5811222000010123456789030', 'NO9386011117947', 'SM86U0322509800000000270100',
  'SI56263300012039086',
];

describe('value-safe cut against the real shield: IBANs of all countries and every value kind', () => {
  it('the detector recognises each value whole (raw labels leak nothing)', async () => {
    const missed: string[] = [];
    for (const value of ALL_VALUES) {
      if ((await leakOffsets(value, { labels: 'raw' })).length > 0) missed.push(value);
    }
    // A detector limit, not the cut: these leak whole even with raw labels; the value-safe cut still never leaks more.
    expect(missed).toEqual(DETECTOR_MISSES);
  }, 120_000);

  it('sends no fragment of any of them at offsets 70-130', async () => {
    const found: Record<string, number[]> = {};
    for (const value of ALL_VALUES.filter((v) => !DETECTOR_MISSES.includes(v))) {
      const offsets = await leakOffsets(value);
      if (offsets.length > 0) found[value] = offsets;
    }
    expect(found).toEqual({});
  }, 120_000);

  it('never leaks at an offset where the 0.24.2 cut did not (also lower-case IBANs, BIC, PLZ and city)', async () => {
    const values = [...ALL_VALUES, ...IBANS.map((iban) => iban.toLowerCase()), 'DEUTDEFF', 'NWBKGB2L', 'M AB 1234', '4 O 123/24', '80331 München', '00017 Projektraum'];
    const worse: Record<string, number[]> = {};
    for (const value of values) {
      const grapheme = new Set(await leakOffsets(value, { labelCut: 'grapheme' }));
      const extra = (await leakOffsets(value)).filter((offset) => !grapheme.has(offset));
      if (extra.length > 0) worse[value] = extra;
    }
    expect(worse).toEqual({});
  }, 180_000);
});

describe('value-safe cut: each trigger on its own', () => {
  const pad = (length: number) => 'notiz '.repeat(30).slice(0, length - 1);
  it.each<[string, string]>([
    ['only @', 'max@localhost'],
    ['only a dot inside', 'www.kanzlei-wendt.de'],
    ['only a digit', 'Raum4711'],
  ])('%s', (_name, value) => {
    const label = `${pad(116)} ${value} Ende der Notiz`;
    expect(canonicalMentionLabel(label, { cut: 'value-safe' })).toBe(`${pad(116)}…`);
    expect(canonicalMentionLabel(label, { cut: 'grapheme' })).toBe(`${label.slice(0, 119)}…`);
  });

  it('an upper-case group of 1-4 letters next to a value belongs to it (cut inside NWBK, or right before it)', () => {
    for (const at of [113, 114]) {
      const label = `${pad(at)} GB29 NWBK 6016 1331 9268 19 Ende`;
      expect(canonicalMentionLabel(label, { cut: 'value-safe' }), String(at)).toBe(`${pad(at)}…`);
    }
  });

  it('an acronym next to plain words is a word: KG, EU, USA, GmbH change nothing', () => {
    const label = `${pad(110)} ACME KG EU USA GmbH Vertrag`;
    expect(canonicalMentionLabel(label, { cut: 'value-safe' })).toBe(canonicalMentionLabel(label, { cut: 'grapheme' }));
  });
});

