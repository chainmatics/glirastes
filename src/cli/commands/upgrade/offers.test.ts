import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBaseline } from './baseline.js';
import { createOffersList, formatOffersList } from './offers.js';
import { runUpgradeCommand } from './report.js';

let root: string;
let notesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'upgrade-offers-'));
  notesDir = join(root, '.notes', 'upgrade-notes');
  await mkdir(notesDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

function note(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, summary: `${id} summary`, howTo: `${id} how`, skill: 'some-skill', ...extra };
}

async function writeNotes(version: string, notes: unknown[]) {
  await writeFile(join(notesDir, `${version}.json`), JSON.stringify({ version, notes }));
}

async function seed() {
  await writeNotes('0.18.0', [note('old-offer', 'optional', { adoptedWhen: { patterns: ['useOld\\('] } })]);
  await writeNotes('0.19.0', [
    note('new-offer', 'optional', { adoptedWhen: { patterns: ['useNew\\('] } }),
    note('plain-offer', 'optional'),
    note('break-one', 'breaking'),
  ]);
  await writeNotes('0.20.0', [note('future-offer', 'optional')]);
}

const opts = (extra = {}) => ({ rootDir: root, sdkVersion: '0.19.0', notesDir, ...extra });

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { cwd: root, log: (l: string) => out.push(l), error: (l: string) => err.push(l), sdkVersion: '0.19.0', notesDir } };
}

describe('createOffersList', () => {
  it('lists optional notes up to the installed version that the app does not use, newest first', async () => {
    await seed();
    await writeFile(join(root, 'app.ts'), 'useOld();\n');
    const list = await createOffersList(opts());
    expect(list.offers.map((offer) => offer.id)).toEqual(['new-offer', 'plain-offer']);
    expect(list.offers.find((offer) => offer.id === 'plain-offer')?.undetectable).toBe(true);
    expect(list.offers.find((offer) => offer.id === 'new-offer')?.undetectable).toBe(false);
  });

  it('keeps offers from versions an ack already passed', async () => {
    await seed();
    await writeBaseline(root, { schemaVersion: 1, reviewedThrough: '0.19.0', decisions: {} });
    const list = await createOffersList(opts());
    expect(list.offers.map((offer) => offer.id)).toEqual(['new-offer', 'plain-offer', 'old-offer']);
  });

  it('--since limits the list and deferred offers are marked', async () => {
    await seed();
    await writeBaseline(root, {
      schemaVersion: 1,
      reviewedThrough: '0.19.0',
      decisions: { 'new-offer': { decision: 'deferred', version: '0.19.0' } },
    });
    const list = await createOffersList(opts({ since: '0.18.0' }));
    expect(list.offers.map((offer) => offer.id)).toEqual(['new-offer', 'plain-offer']);
    expect(list.offers[0]?.deferred).toBe(true);
    const text = formatOffersList(list);
    expect(text).toContain('after 0.18.0 up to 0.19.0');
    expect(text).toContain('- [new-offer] new-offer summary [deferred] → some-skill');
    expect(text).toContain('[use not detectable]');
  });

  it('says so when nothing is left', async () => {
    await writeNotes('0.19.0', [note('break-one', 'breaking')]);
    expect(formatOffersList(await createOffersList(opts()))).toBe(
      'No optional Glirastes features left to adopt (up to 0.19.0).',
    );
  });
});

describe('glirastes upgrade offers', () => {
  it('prints the list and changes no file', async () => {
    await seed();
    const { out, err, io: cmdIo } = io();
    expect(await runUpgradeCommand(['offers'], cmdIo)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('[old-offer]');
    await expect(import('node:fs/promises').then((fs) => fs.access(join(root, '.glirastes')))).rejects.toThrow();
  });

  it('--json returns the list and a bad --since is a usage error', async () => {
    await seed();
    const json = io();
    expect(await runUpgradeCommand(['offers', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out.join('\n')).offers).toHaveLength(3);
    const bad = io();
    expect(await runUpgradeCommand(['offers', '--since', 'soon'], bad.io)).toBe(2);
  });

  it('ack points to offers when optional items leave the report', async () => {
    await seed();
    await writeBaseline(root, { schemaVersion: 1, reviewedThrough: '0.18.0', decisions: {} });
    const { out, io: cmdIo } = io();
    expect(await runUpgradeCommand(['ack', '--force'], cmdIo)).toBe(0);
    expect(out).toContain('2 optional features leave this report; `glirastes upgrade offers` lists them any time.');
  });
});
