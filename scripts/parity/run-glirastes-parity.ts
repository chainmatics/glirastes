/**
 * Glirastes Parity Harness
 *
 * Compares legacy local SDK outputs vs Glirastes-backed outputs.
 * Reads test fixtures from fixtures/runtime-cases.json and validates
 * that Glirastes API responses match the expected structural shape.
 *
 * Usage:
 *   GLIRASTES_URL=https://staging.glirastes.example.com \
 *   GLIRASTES_API_KEY=sk-... \
 *   npx tsx scripts/parity/run-glirastes-parity.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GLIRASTES_URL = process.env.GLIRASTES_URL || 'http://localhost:3000';
const API_KEY = process.env.GLIRASTES_API_KEY || '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  input: Record<string, unknown>;
  expectedShape: Record<string, string>;
}

interface FixtureSuite {
  gate: Fixture[];
  primus: Fixture[];
  config: Fixture[];
  aegis: Fixture[];
}

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function callGlirastes(
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${GLIRASTES_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function validateShape(
  data: unknown,
  expectedShape: Record<string, string>,
): string[] {
  const errors: string[] = [];

  if (data === null || typeof data !== 'object') {
    return ['Response is not an object'];
  }

  const obj = data as Record<string, unknown>;

  for (const [key, expectedType] of Object.entries(expectedShape)) {
    const optional = expectedType.endsWith('?');
    const type = expectedType.replace('?', '');

    if (!(key in obj)) {
      if (!optional) errors.push(`Missing key: ${key}`);
      continue;
    }

    const val = obj[key];

    switch (type) {
      case 'array':
      case 'string[]':
        if (!Array.isArray(val)) {
          errors.push(`${key}: expected ${type}, got ${typeof val}`);
        }
        break;
      case 'string':
        if (typeof val !== 'string') {
          errors.push(`${key}: expected string, got ${typeof val}`);
        }
        break;
      case 'number':
        if (typeof val !== 'number') {
          errors.push(`${key}: expected number, got ${typeof val}`);
        }
        break;
      case 'boolean':
        if (typeof val !== 'boolean') {
          errors.push(`${key}: expected boolean, got ${typeof val}`);
        }
        break;
      case 'object':
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          errors.push(`${key}: expected object, got ${typeof val}`);
        }
        break;
      default:
        errors.push(`${key}: unknown expected type "${type}"`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Suite runners
// ---------------------------------------------------------------------------

async function runGateTests(fixtures: Fixture[]): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const f of fixtures) {
    try {
      const data = await callGlirastes('/api/warden/gate/filter', 'POST', f.input);
      const errs = validateShape(data, f.expectedShape);
      results.push({
        suite: 'gate',
        name: f.name,
        passed: errs.length === 0,
        error: errs.length ? errs.join('; ') : undefined,
      });
    } catch (err) {
      results.push({
        suite: 'gate',
        name: f.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function runPrimusTests(fixtures: Fixture[]): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const f of fixtures) {
    try {
      const data = await callGlirastes('/api/primus/classify', 'POST', f.input);
      const errs = validateShape(data, f.expectedShape);
      results.push({
        suite: 'primus',
        name: f.name,
        passed: errs.length === 0,
        error: errs.length ? errs.join('; ') : undefined,
      });
    } catch (err) {
      results.push({
        suite: 'primus',
        name: f.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function runConfigTests(fixtures: Fixture[]): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const f of fixtures) {
    try {
      const modules = f.input.modules as string[];
      const query = modules.map((m) => `modules=${encodeURIComponent(m)}`).join('&');
      const data = await callGlirastes(`/api/config?${query}`, 'GET');
      const errs = validateShape(data, f.expectedShape);
      results.push({
        suite: 'config',
        name: f.name,
        passed: errs.length === 0,
        error: errs.length ? errs.join('; ') : undefined,
      });
    } catch (err) {
      results.push({
        suite: 'config',
        name: f.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function runAegisTests(fixtures: Fixture[]): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const f of fixtures) {
    try {
      const data = await callGlirastes('/api/aegis/scan', 'POST', f.input);
      const errs = validateShape(data, f.expectedShape);
      results.push({
        suite: 'aegis',
        name: f.name,
        passed: errs.length === 0,
        error: errs.length ? errs.join('; ') : undefined,
      });
    } catch (err) {
      results.push({
        suite: 'aegis',
        name: f.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fixturesPath = resolve(__dirname, 'fixtures/runtime-cases.json');
  const cases: FixtureSuite = JSON.parse(readFileSync(fixturesPath, 'utf8'));

  console.log(`Glirastes Parity Harness`);
  console.log(`Target: ${GLIRASTES_URL}`);
  console.log(`Suites: gate(${cases.gate.length}), primus(${cases.primus.length}), config(${cases.config.length}), aegis(${cases.aegis.length})\n`);

  const results: TestResult[] = [];

  results.push(...(await runGateTests(cases.gate)));
  results.push(...(await runPrimusTests(cases.primus)));
  results.push(...(await runConfigTests(cases.config)));
  results.push(...(await runAegisTests(cases.aegis)));

  // Report per-suite
  const suites = ['gate', 'primus', 'config', 'aegis'] as const;
  for (const suite of suites) {
    const suiteResults = results.filter((r) => r.suite === suite);
    const passed = suiteResults.filter((r) => r.passed).length;
    const icon = passed === suiteResults.length ? 'PASS' : 'FAIL';
    console.log(`[${icon}] ${suite}: ${passed}/${suiteResults.length}`);

    for (const r of suiteResults) {
      if (r.passed) {
        console.log(`       + ${r.name}`);
      } else {
        console.log(`       - ${r.name}: ${r.error}`);
      }
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\nParity Results: ${passed} passed, ${failed} failed out of ${results.length}`);

  if (failed > 0) {
    process.exit(1);
  }

  console.log('\nAll parity checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
