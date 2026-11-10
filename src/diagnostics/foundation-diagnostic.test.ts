import { describe, expect, it } from 'vitest';
import {
  FoundationDiagnosticError,
  foundationDiagnosticJson,
  isFoundationDiagnosticError,
} from './foundation-diagnostic.js';

describe('FoundationDiagnosticError', () => {
  it('serializes only the bounded versioned diagnostic contract', () => {
    const error = new FoundationDiagnosticError({
      code: 'E-SETUP-001',
      operation: 'setup.plan',
      message: 'Setup configuration is incomplete.',
      remediation: 'configure-control-plane',
      path: '.glirastes/tool-semantics.json',
      identifier: 'tasks.list',
    });
    Object.assign(error, {
      cause: new Error('raw provider response'),
      responseBody: 'secret response',
      prompt: 'private prompt',
      source: 'private source',
      argument: { secret: true },
      result: { private: true },
      credential: 'credential-value',
    });

    expect(foundationDiagnosticJson(error)).toEqual({
      schemaVersion: 1,
      code: 'E-SETUP-001',
      operation: 'setup.plan',
      message: 'Setup configuration is incomplete.',
      remediation: 'configure-control-plane',
      path: '.glirastes/tool-semantics.json',
      identifier: 'tasks.list',
    });
    expect(JSON.stringify(foundationDiagnosticJson(error)))
      .not.toMatch(/provider|secret response|private prompt|private source|credential-value/);
    expect(isFoundationDiagnosticError(error)).toBe(true);
  });

  it('reduces unknown failures to a generic content-free diagnostic', () => {
    const diagnostic = foundationDiagnosticJson(
      new Error('Bearer raw-secret-value in response body'),
      'cli',
    );

    expect(diagnostic).toEqual({
      schemaVersion: 1,
      code: 'E-SETUP-999',
      operation: 'cli',
      message: 'Glirastes command failed.',
      remediation: 'inspect-local-diagnostics',
    });
  });
});
