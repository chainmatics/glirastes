import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  checkEgressInventory,
  EgressInventorySchema,
  scanSourceForEgress,
  scanTreeForEgress,
  type EgressInventory,
} from '../../../codegen/model-egress.js';
import { protectedGenerateText, protectedStreamText } from '../model-calls.js';
import { createPrivacyBoundary } from '../model-boundary.js';
import { CANARY, CANARY_PATTERN, captureModel, memoryShield, testScope } from './privacy-fixtures.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const INVENTORY = EgressInventorySchema.parse(
  JSON.parse(readFileSync(new URL('../../../contracts/privacy-egress-inventory.json', import.meta.url), 'utf8')),
);
const EMPTY: EgressInventory = { schemaVersion: 1, entries: [] };

function scanFixture(source: string) {
  return checkEgressInventory(scanSourceForEgress('src/fixture.ts', source), EMPTY);
}

describe('model egress inventory', () => {
  it('the SDK source tree matches its reviewed inventory exactly', () => {
    expect(checkEgressInventory(scanTreeForEgress(ROOT), INVENTORY)).toEqual([]);
  });

  it.each([
    ['aliased streamText outside the boundary', `import { streamText as st } from 'ai';\nst({ model, prompt });`, 'streamText'],
    ['named generateObject', `import { generateObject } from 'ai';`, 'generateObject'],
    ['namespace member', `import * as ai from 'ai';\nai.generateText({ model, prompt });`, 'generateText'],
    ['namespace element access', `import * as ai from 'ai';\nai['streamObject']({});`, 'streamObject'],
    ['escaping namespace', `import * as ai from 'ai';\nrun(ai);`, '*'],
    ['dynamic import destructured', `const { generateText: g } = await import('ai');`, 'generateText'],
    ['dynamic import member', `async function run() { return (await import('ai')).streamText({}); }`, 'streamText'],
    ['require', `const { embed } = require('ai');`, 'embed'],
    ['re-export', `export { streamText as run } from 'ai';`, 'streamText'],
    ['star re-export', `export * from 'ai';`, '*'],
    ['experimental transcription', `import { experimental_transcribe } from 'ai';`, 'experimental_transcribe'],
    ['raw provider call', `await model.doStream(options);`, 'doStream'],
  ])('refuses a new direct model call: %s', (_label, source, symbol) => {
    expect(scanFixture(source)).toContainEqual(expect.objectContaining({ code: 'unapproved_model_call', symbol }));
  });

  it.each([
    ['provider constructor', `import { createOpenAI } from '@ai-sdk/openai';`, 'unapproved_provider_import', '@ai-sdk/openai'],
    ['provider dynamic import', `const m = await import('@openrouter/ai-sdk-provider');`, 'unapproved_provider_import', '@openrouter/ai-sdk-provider'],
    ['computed import', `const m = await import(name);`, 'unapproved_dynamic_import', '<computed>'],
    ['global fetch', `await fetch(url, { body });`, 'unapproved_network_call', 'fetch'],
    ['fetch as a value', `const f = options.fetch ?? globalThis.fetch;`, 'unapproved_network_call', 'fetch'],
    ['websocket', `new WebSocket(url);`, 'unapproved_network_call', 'WebSocket'],
  ])('refuses an unreviewed %s', (_label, source, code, symbol) => {
    expect(scanFixture(source)).toContainEqual(expect.objectContaining({ code, symbol }));
  });

  it.each([
    ['type-only import', `import type { streamText } from 'ai';\ntype P = Parameters<typeof streamText>[0];`],
    ['content-free ai helpers', `import { tool, zodSchema, createUIMessageStream } from 'ai';`],
    ['react hook package', `import { useChat } from '@ai-sdk/react';`],
    ['type-only provider import', `import type { LanguageModelV3 } from '@ai-sdk/provider';`],
    ['a member or key named fetch', `registry.fetch(ref);\nconst o = { fetch: 1 };\ninterface X { fetch(): void }\nfunction f(fetch: typeof globalThis.fetch) {}`],
  ])('accepts %s', (_label, source) => {
    expect(scanFixture(source)).toEqual([]);
  });

  it('a stale or duplicate entry fails, so the inventory never names a removed call', () => {
    const entry = { file: 'src/gone.ts', symbol: 'fetch', kind: 'network', decision: 'content-free', reason: 'Removed long ago.' } as const;
    expect(checkEgressInventory([], { schemaVersion: 1, entries: [entry, entry] })).toEqual([
      { code: 'duplicate_inventory_entry', file: 'src/gone.ts', symbol: 'fetch' },
      { code: 'stale_inventory_entry', file: 'src/gone.ts', symbol: 'fetch' },
    ]);
  });

  it('an entry needs a decision and a reason', () => {
    expect(() => EgressInventorySchema.parse({ schemaVersion: 1, entries: [{ file: 'a', symbol: 'fetch', kind: 'network', decision: 'ok', reason: '' }] })).toThrow();
  });
});

describe('model-call facades', () => {
  it('wrap the model with the given boundary before the call', async () => {
    const session = await memoryShield().open(testScope());
    await session.registerIdentities([{ id: CANARY.userId, name: CANARY.name, email: CANARY.email }]);
    const boundary = createPrivacyBoundary({ session });
    const generated = captureModel([{ text: 'ok' }]);
    await protectedGenerateText({ model: generated.model, prompt: `Mail an ${CANARY.email}` }, boundary);
    const streamed = captureModel([{ text: 'ok' }]);
    await protectedStreamText({ model: streamed.model, prompt: `Hallo ${CANARY.name}` }, boundary).text;
    expect(JSON.stringify([generated.calls, streamed.calls])).not.toMatch(CANARY_PATTERN);
    expect(generated.calls).toHaveLength(1);
  });

  it('refuse a protection that hands the model back unwrapped', async () => {
    const model = new MockLanguageModelV3();
    expect(() => protectedGenerateText({ model, prompt: 'x' }, { wrapModel: (m) => m })).toThrow(expect.objectContaining({ code: 'privacy_unsupported_content' }));
    expect(() => protectedStreamText({ model, prompt: 'x' }, {} as never)).toThrow(expect.objectContaining({ code: 'privacy_scope_invalid' }));
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
