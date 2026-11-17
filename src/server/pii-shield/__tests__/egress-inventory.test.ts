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
  }, 60_000); // parses every source file; slow under a loaded full suite

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
    ['raw provider call by key', `await model['doGenerate'](options);`, 'doGenerate'],
    ['AI SDK 6 agent', `import { ToolLoopAgent } from 'ai';`, 'ToolLoopAgent'],
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
    ['fetch by key', `globalThis['fetch'](url);`, 'unapproved_network_call', 'fetch'],
    ['node https', `import https from 'node:https';`, 'unapproved_network_call', 'node:https'],
    ['axios', `const axios = require('axios');`, 'unapproved_network_call', 'axios'],
    ['beacon', `navigator.sendBeacon(url, body);`, 'unapproved_network_call', 'sendBeacon'],
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

  it.each([
    ['literal null', `import { protectedStreamText } from '../pii-shield/model-calls.js';\nprotectedStreamText({ model }, null);`, 'protectedStreamText(null)'],
    ['undefined', `import { protectedGenerateText } from './model-calls.js';\nprotectedGenerateText({ model }, undefined);`, 'protectedGenerateText(null)'],
    ['missing argument', `import { protectedGenerateObject } from './model-calls.js';\nprotectedGenerateObject({ model } as never);`, 'protectedGenerateObject(null)'],
    ['aliased import', `import { protectedStreamText as run } from 'glirastes/server';\nrun({ model }, null);`, 'protectedStreamText(null)'],
    ['namespace member', `import * as calls from './model-calls.js';\ncalls.protectedStreamText({ model }, null);`, 'protectedStreamText(null)'],
    ['nullable expression', `import { protectedStreamText } from './model-calls.js';\nprotectedStreamText({ model }, ctx.privacy?.boundary ?? null);`, 'protectedStreamText(nullable)'],
    ['boundary argument', `import { protectedStreamText } from './model-calls.js';\nprotectedStreamText({ model }, boundary);`, 'protectedStreamText(boundary)'],
    ['escaped facade', `import { protectedStreamText } from './model-calls.js';\nrun(protectedStreamText);`, 'protectedStreamText(escaped)'],
  ])('inventories every facade call site with its protection: %s', (_label, source, symbol) => {
    expect(scanFixture(source)).toContainEqual(expect.objectContaining({ code: 'unapproved_facade_call', symbol }));
  });

  it('a new unlabelled null facade call is a violation, a reviewed one passes', () => {
    const source = `import { protectedStreamText } from './model-calls.js';\nexport const a = () => protectedStreamText({ model }, null);`;
    const findings = scanSourceForEgress('src/new-route.ts', source);
    expect(checkEgressInventory(findings, EMPTY)).toEqual([
      { code: 'unapproved_facade_call', file: 'src/new-route.ts', symbol: 'protectedStreamText(null)', line: 2 },
    ]);
    const reviewed: EgressInventory = { schemaVersion: 1, entries: [{
      file: 'src/new-route.ts', symbol: 'protectedStreamText(null)', kind: 'facade_call', decision: 'exception',
      reason: 'Privacy is refused before this route runs.',
    }] };
    expect(checkEgressInventory(findings, reviewed)).toEqual([]);
  });

  it('does not treat the facade definitions or unrelated functions as call sites', () => {
    expect(scanFixture(`function protectedStreamText(a: unknown, b: unknown) {}\nprotectedStreamText(1, null);`)).toEqual([]);
  });

  it.each([
    ['video generation', `import { experimental_generateVideo } from 'ai';`, 'unapproved_model_call', 'experimental_generateVideo'],
    ['ollama', `import ollama from 'ollama';`, 'unapproved_provider_import', 'ollama'],
    ['ollama provider', `import { createOllama } from 'ollama-ai-provider';`, 'unapproved_provider_import', 'ollama-ai-provider'],
    ['langchain scope', `import { ChatOpenAI } from '@langchain/openai';`, 'unapproved_provider_import', '@langchain/openai'],
    ['langchain dynamic', `const m = await import('@langchain/core/messages');`, 'unapproved_provider_import', '@langchain/core/messages'],
    ['langchain core package', `import { x } from 'langchain';`, 'unapproved_provider_import', 'langchain'],
  ])('treats %s as egress', (_label, source, code, symbol) => {
    expect(scanFixture(source)).toContainEqual(expect.objectContaining({ code, symbol }));
  });

  it('a second call in a file with a reviewed one fails until the count is raised', () => {
    const source = `import { generateText } from 'ai';\nexport const a = () => fetch(x);\nexport const b = () => fetch(y);`;
    const findings = scanSourceForEgress('src/f.ts', source);
    const entry = (count?: number) => ({ file: 'src/f.ts', symbol: 'fetch', kind: 'network' as const, decision: 'protected' as const, reason: 'Calls the app backend.', ...(count ? { count } : {}) });
    const model = { file: 'src/f.ts', symbol: 'generateText', kind: 'model_call' as const, decision: 'facade' as const, reason: 'The facade itself.' };
    expect(checkEgressInventory(findings, { schemaVersion: 1, entries: [model, entry()] }))
      .toEqual([{ code: 'inventory_count_mismatch', file: 'src/f.ts', symbol: 'fetch', line: 3 }]);
    expect(checkEgressInventory(findings, { schemaVersion: 1, entries: [model, entry(2)] })).toEqual([]);
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
