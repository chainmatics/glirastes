import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The acceptance record and the user-test protocol are release documents: the
 * record must cover every MVP requirement with evidence that exists, and the
 * protocol must ask for the same measures in each of the five flows.
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(SDK_ROOT, path), 'utf8');

describe('acceptance record', () => {
  const record = read('docs/acceptance/0.5.0-acceptance.md');

  it('covers FR-1 to FR-8, each with evidence and a human step', () => {
    const rows = record.split('\n').filter((line) => /^\| FR-\d /.test(line));
    expect(rows.map((row) => row.slice(2, 6))).toEqual(['FR-1', 'FR-2', 'FR-3', 'FR-4', 'FR-5', 'FR-6', 'FR-7', 'FR-8']);
    for (const row of rows) {
      const [, evidence, person] = row.slice(1, -1).split('|').map((cell) => cell.trim());
      expect(evidence, row).toMatch(/`[^`]+`/);
      expect(person, row).not.toBe('');
    }
  });

  it('names only SDK evidence that exists', () => {
    const paths = [...record.matchAll(/`((?:src|tests|docs)\/[^`\s]+)`/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThanOrEqual(20);
    expect(paths.filter((path) => !existsSync(join(SDK_ROOT, path)))).toEqual([]);
  });
});

describe('user test protocol', () => {
  const protocol = read('docs/acceptance/user-test-protocol.md');
  const FLOWS = ['Setup', 'Status check', 'Change takeover', 'Usage overview', 'Rollback'];

  it('asks for the same five measures in each of the five flows', () => {
    const flows = protocol.split('\n## Flow ').slice(1);
    expect(flows.map((flow) => flow.split('\n')[0])).toEqual(FLOWS.map((name, index) => `${index + 1}: ${name}`));
    for (const flow of flows) {
      const measures = [...flow.matchAll(/^\| (Success|Help needed|Failed attempts|Dead ends|Times \(download \/ agent \/ input\)) \|/gm)]
        .map((match) => match[1]);
      expect(measures, flow.split('\n')[0]).toEqual([
        'Success', 'Help needed', 'Failed attempts', 'Dead ends', 'Times (download / agent / input)',
      ]);
      expect(flow, flow.split('\n')[0]).toMatch(/\nDone when: /);
    }
  });

  it('forbids spoken help and keeps the security confirmations visible', () => {
    expect(protocol).toContain('gives no spoken help');
    expect(protocol).toContain('Write and delete tools asked before running');
  });
});

describe('second acceptance app protocol', () => {
  const protocol = read('docs/acceptance/second-app-vue-fastapi.md');
  const template = read('docs/acceptance/records/second-app-vue-fastapi-template.md');

  it('lists cases 1 to 17, each with tool calls, a visible result and what to record', () => {
    const rows = protocol.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    expect(rows.map((row) => Number(row.split('|')[1]))).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    for (const row of rows) {
      const cells = row.slice(1, -1).split(' | ').map((cell) => cell.trim());
      expect(cells, row).toHaveLength(5);
      expect(cells.every((cell) => cell !== ''), row).toBe(true);
    }
  });

  it('names only paths that exist, and each known gap has its test', () => {
    const paths = [...`${protocol}\n${template}`.matchAll(/`((?:src|tests|docs|examples)\/[^`\s<]+)`/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((path) => !existsSync(join(SDK_ROOT, path)))).toEqual([]);
    const gaps = [...protocol.matchAll(/^\| (SA-\d\d) \|/gm)].map((match) => match[1]!);
    const tests = read('tests/second-acceptance-vue-fastapi.test.ts');
    expect([...tests.matchAll(/it\('KNOWN GAP (SA-\d\d):/g)].map((match) => match[1])).toEqual(gaps);
  });

  it('records every case for both models as a pass rate of three runs', () => {
    const rows = template.split('\n').filter((line) => /^\| \d+(-DE)? \|/.test(line));
    expect(new Set(rows.map((row) => row.split('|')[1]!.trim().replace('-DE', ''))))
      .toEqual(new Set(Array.from({ length: 17 }, (_, index) => String(index + 1))));
    for (const row of rows) expect(row.match(/\/3/g), row).toHaveLength(2);
  });
});
