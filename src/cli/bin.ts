#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCli } from './index.js';
import {
  foundationDiagnosticJson,
  isFoundationDiagnosticError,
} from '../diagnostics/index.js';
import { shouldLoadImplicitEnvironment } from './environment-loading.js';

const cliArgs = process.argv.slice(2);
if (shouldLoadImplicitEnvironment(cliArgs)) {
  // Transitional commands retain their existing implicit dotenv behavior.
  for (const envFile of ['.env', '.env.local']) {
    try {
      const content = readFileSync(resolve(process.cwd(), envFile), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex < 0) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const raw = trimmed.slice(eqIndex + 1).trim();
        const value = raw.replace(/^["']|["']$/g, '');
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch {
      // File doesn't exist — skip
    }
  }
}

runCli(cliArgs).catch((error: unknown) => {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(foundationDiagnosticJson(error, 'cli')));
  } else if (isFoundationDiagnosticError(error)) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error('E-SETUP-999: Glirastes command failed.');
  }
  process.exit(1);
});
