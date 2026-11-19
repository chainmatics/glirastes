import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, measureAll, renderSummary, renderTable, type Measurement } from './support/history-measurement.js';

/**
 * The measurement behind `docs/history-measurement.md`: deterministic and
 * model-free. The committed tables must match what the code produces;
 * `UPDATE_HISTORY_MEASUREMENT=1 bunx vitest run tests/history-measurement.test.ts`
 * rewrites them after a deliberate change.
 */
const DOC = resolve(import.meta.dirname, '..', 'docs', 'history-measurement.md');

let rows: Measurement[] | undefined;
const allRows = async () => (rows ??= await measureAll());
const find = (all: Measurement[], match: Partial<Measurement>) => all.find((row) => Object.entries(match).every(([key, value]) => row[key as keyof Measurement] === value))!;

/** The text between `<!-- name:start -->` and `<!-- name:end -->`, and the doc with `table` there. */
function section(doc: string, name: string, table: string): { current: string; updated: string } {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return {
    current: doc.slice(from + start.length, to).trim(),
    updated: `${doc.slice(0, from + start.length)}\n${table}\n${doc.slice(to)}`,
  };
}

describe('history measurement', () => {
  it('the documented tables are the measured ones', async () => {
    const all = await allRows();
    let doc = readFileSync(DOC, 'utf8');
    const update = process.env.UPDATE_HISTORY_MEASUREMENT === '1';
    for (const [name, table] of [['summary', renderSummary(all)], ['measurement', renderTable(all)]] as const) {
      const { current, updated } = section(doc, name, table);
      if (update) doc = updated;
      else expect(current).toBe(table);
    }
    if (update) writeFileSync(DOC, doc);
  }, 60_000);

  it('the default loses the list after one turn without tools; tool-turns keeps it', async () => {
    const all = await allRows();
    for (const fixture of FIXTURES) {
      const base = { scenario: fixture.name, followUps: 1, toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 };
      expect(find(all, { ...base, variant: 'all-turns' }).ids).toBe(0);
      expect(find(all, { ...base, variant: 'tool-turns' }).pairs).toBeGreaterThan(0);
    }
  }, 60_000);

  it('the memo lists nothing for an app without declarations', async () => {
    const all = await allRows();
    const base = { scenario: 'pilot uuid list 20, undeclared', followUps: 3, toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 };
    expect(find(all, { ...base, variant: 'all-turns + memo' })).toMatchObject({ ids: 0, estimatedTokens: find(all, { ...base, variant: 'all-turns' }).estimatedTokens });
  }, 60_000);
});
