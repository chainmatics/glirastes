import { describe, expect, it } from 'vitest';
import type { ToolsPipelineTool } from '../../codegen/tools/pipeline.js';
import { contractViolations, mergeResolutions, mergeSemantics, rejectedKeys, withoutTools, writePolicy } from '../enrich-guard.js';

const CURRENT = `sha256:${'c'.repeat(43)}`;
const OLD = `sha256:${'o'.repeat(43)}`;
const MODEL = 'anthropic/claude-sonnet-5.5';

const tool = (stableKey: string, rejected = false) => ({
  stableKey,
  interfaceDigest: CURRENT,
  semantics: { protectedFields: [], hasSynonyms: false, missingExamples: [], stale: false, rejected },
}) as unknown as ToolsPipelineTool;

const SYNONYMS = { de: ['Erinnerung', 'Reminder', 'Wecker'], en: ['reminder', 'nudge'] };
const STORED = {
  schemaVersion: 1,
  tools: [
    // Curated by a person: never the job's.
    { stableKey: 'human', description: 'Human prose that stays.', synonyms: SYNONYMS },
    // Written by an agent for the current interface: stays, only a missing language may be added.
    {
      stableKey: 'current',
      description: 'Current agent prose.',
      synonyms: { de: ['Erinnerung'] },
      origin: { description: 'agent', synonyms: 'agent' },
      agent: { model: 'claude-code', interfaceDigest: CURRENT },
    },
    // Written by an agent for an earlier interface: the job renews its agent fields, not the locked one.
    {
      stableKey: 'stale',
      description: 'Old agent prose.',
      synonyms: SYNONYMS,
      origin: { description: 'agent', synonyms: 'human' },
      agent: { model: 'claude-code', interfaceDigest: OLD },
    },
    // Not in scope at all.
    { stableKey: 'outside', description: 'Untouched.', origin: { description: 'agent' }, agent: { model: 'x/y', interfaceDigest: OLD } },
  ],
};
const storedText = `${JSON.stringify(STORED, null, 2)}\n`;
const scope = new Set(['human', 'current', 'stale', 'new']);
const policyFor = (semantics: string | null = storedText, resolutions: string | null = null) => writePolicy({
  tools: ['human', 'current', 'stale', 'outside', 'new'].map((key) => tool(key)),
  scope,
  resolutionScope: new Set(['new', 'stale']),
  semantics,
  resolutions,
  rejected: new Set(),
  conventions: false,
});

describe('writePolicy', () => {
  it('opens missing fields and stale agent fields, never human, locked or current ones', () => {
    const policy = policyFor();
    expect([...policy.tools.get('human')!.fields]).not.toContain('synonyms');
    expect([...policy.tools.get('human')!.fields]).not.toContain('description');
    expect([...policy.tools.get('human')!.fields]).toContain('examples');
    expect([...policy.tools.get('current')!.fields]).not.toContain('description');
    expect(policy.tools.get('current')!.languages.get('synonyms')).toEqual(['en']);
    expect([...policy.tools.get('stale')!.fields]).toContain('description');
    expect([...policy.tools.get('stale')!.fields]).not.toContain('synonyms');
    expect(policy.tools.has('outside')).toBe(false);
    expect(policy.tools.get('new')!.resolution).toBe(true);
  });

  it('lets a person-written or reviewed resolution entry stand, renews a stale agent one', () => {
    const resolutions = JSON.stringify({
      schemaVersion: 1,
      tools: {
        new: { origin: 'human', interfaceDigest: OLD },
        stale: { origin: 'agent', model: 'x/y', interfaceDigest: OLD },
      },
    });
    const policy = policyFor(storedText, resolutions);
    expect(policy.tools.get('new')!.resolution).toBe(false);
    expect(policy.tools.get('stale')!.resolution).toBe(true);
    expect(policy.tools.get('human')!.resolution).toBe(false);
  });
});

describe('mergeSemantics', () => {
  it('keeps every stored entry, takes only allowed values and stamps them as the job’s', () => {
    // The model rewrote the file: dropped two entries, replaced curated synonyms and claimed origins.
    const proposed = JSON.stringify({
      tools: [
        { stableKey: 'human', description: 'Worse.', synonyms: { en: ['x'] }, examples: { en: ['a b', 'c d', 'e f'] } },
        { stableKey: 'current', description: 'Worse.', synonyms: { de: ['x'], en: ['reminder'] } },
        { stableKey: 'stale', description: 'Renewed prose.', synonyms: { en: ['x'] }, origin: { description: 'human' } },
        { stableKey: 'new', description: 'New prose.', module: 'tasks', origin: { module: 'tasks' }, invented: 1 },
        { stableKey: 'stranger', description: 'Not in scope.' },
      ],
    });

    const merged = mergeSemantics(storedText, proposed, policyFor(), MODEL);
    const tools = (JSON.parse(merged.text!) as typeof STORED).tools as Array<Record<string, unknown>>;

    expect(merged.changed.sort()).toEqual(['current', 'human', 'new', 'stale']);
    expect(tools.map((entry) => entry.stableKey)).toEqual(['human', 'current', 'stale', 'outside', 'new']);
    expect(tools[0]).toMatchObject({ description: 'Human prose that stays.', synonyms: SYNONYMS, origin: { examples: 'agent' } });
    expect(tools[1]).toMatchObject({ description: 'Current agent prose.', synonyms: { de: ['Erinnerung'], en: ['reminder'] } });
    expect(tools[2]).toMatchObject({
      description: 'Renewed prose.',
      synonyms: SYNONYMS,
      origin: { description: 'agent', synonyms: 'human' },
      agent: { model: MODEL, interfaceDigest: CURRENT },
    });
    expect(tools[3]).toEqual(STORED.tools[3]);
    expect(tools[4]).toEqual({
      stableKey: 'new',
      description: 'New prose.',
      module: 'tasks',
      origin: { description: 'agent', module: 'agent' },
      agent: { model: MODEL, interfaceDigest: CURRENT },
    });
  });

  it('returns the stored bytes when nothing allowed changed', () => {
    const proposed = JSON.stringify({ tools: [{ stableKey: 'outside', description: 'Changed.' }] });
    expect(mergeSemantics(storedText, proposed, policyFor(), MODEL)).toEqual({ text: storedText, changed: [] });
    expect(mergeSemantics(storedText, '{ broken', policyFor(), MODEL)).toEqual({ text: storedText, changed: [] });
    expect(mergeSemantics(null, '{"tools":[]}', policyFor(null), MODEL)).toEqual({ text: null, changed: [] });
  });

  it('replaces an entry the generator cannot parse with the job’s', () => {
    const broken = JSON.stringify({ schemaVersion: 1, tools: [{ stableKey: 'new', description: 'x', origin: { module: 'tasks' } }] });
    const policy = policyFor(broken);
    const merged = mergeSemantics(broken, JSON.stringify({ tools: [{ stableKey: 'new', description: 'Fixed.' }] }), policy, MODEL);
    expect((JSON.parse(merged.text!) as { tools: unknown[] }).tools).toEqual([{
      stableKey: 'new', description: 'Fixed.', origin: { description: 'agent' }, agent: { model: MODEL, interfaceDigest: CURRENT },
    }]);
  });

  it('takes nothing for a tool whose permissions were withdrawn', () => {
    const proposed = JSON.stringify({ tools: [{ stableKey: 'new', description: 'Rejected.' }] });
    expect(mergeSemantics(storedText, proposed, withoutTools(policyFor(), new Set(['new'])), MODEL).changed).toEqual([]);
  });
});

describe('mergeResolutions', () => {
  it('writes only allowed entries, always as agent entries, and keeps every other one', () => {
    const stored = JSON.stringify({ schemaVersion: 1, tools: { human: { origin: 'human', interfaceDigest: OLD } } });
    const proposed = JSON.stringify({
      tools: {
        new: { origin: 'human', locked: CURRENT, interfaceDigest: CURRENT, input: { jsonSchema: { type: 'object' } } },
        outside: { origin: 'agent', interfaceDigest: CURRENT },
      },
      conventions: { authHelpers: ['getSession'] },
    });
    const merged = mergeResolutions(stored, proposed, policyFor(), MODEL);
    expect(JSON.parse(merged.text!)).toEqual({
      schemaVersion: 1,
      tools: {
        human: { origin: 'human', interfaceDigest: OLD },
        new: { origin: 'agent', model: MODEL, interfaceDigest: CURRENT, input: { jsonSchema: { type: 'object' } } },
      },
    });
    expect(merged.changed).toEqual(['new']);
  });
});

describe('rejectedKeys', () => {
  it('names the tools of rejected entries, by key or by their index in tool-semantics.json', () => {
    const findings = [
      { code: 'resolution-rejected', subjectRef: 'GET /a' },
      { code: 'resolution-rejected', subjectRef: '.glirastes/tool-semantics.json#1' },
      { code: 'semantics-stale', subjectRef: 'GET /c' },
    ];
    expect([...rejectedKeys(findings, storedText)]).toEqual(['GET /a', 'current']);
  });
});

describe('contractViolations', () => {
  const file = (tools: unknown[]) => JSON.stringify({ schemaVersion: 1, appId: 'a', tools });
  const before = file([{ stableKey: 'in', search: ['a'] }, { stableKey: 'out', search: ['b'] }]);

  it('allows changes of tools in scope only', () => {
    expect(contractViolations(before, file([{ stableKey: 'in', search: ['z'] }, { stableKey: 'out', search: ['b'] }]), new Set(['in']))).toEqual([]);
  });

  it('refuses a removed tool, an added tool, an out-of-scope change and a lost header', () => {
    expect(contractViolations(before, file([{ stableKey: 'in' }]), new Set(['in']))).toEqual(['removed out']);
    expect(contractViolations(before, file([{ stableKey: 'in', search: ['a'] }, { stableKey: 'out' }]), new Set(['in'])))
      .toEqual(['changed out outside the scope']);
    expect(contractViolations(before, file([{ stableKey: 'in', search: ['a'] }, { stableKey: 'out', search: ['b'] }, { stableKey: 'x' }]), new Set()))
      .toEqual(['added x']);
    expect(contractViolations(before, JSON.stringify({ tools: JSON.parse(before).tools }), new Set())).toEqual(['the header of tool-contracts.json changed']);
    expect(contractViolations(before, undefined, new Set())).toEqual(['tool-contracts.json is unreadable']);
  });
});
