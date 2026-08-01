import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WIZARD_STATE_PATH,
  WizardStopped,
  isWizardInvocation,
  runSetupWizard,
  type WizardDependencies,
  type WizardIo,
} from './setup-wizard.js';

function recordingIo(answers: string[] = []): WizardIo & { lines: string[] } {
  const lines: string[] = [];
  const queued = [...answers];
  return {
    lines,
    isInteractive: answers.length > 0,
    log: (message: string) => { lines.push(message); },
    ask: async (question: string) => {
      lines.push(question);
      const next = queued.shift();
      if (next === undefined) throw new Error(`Unexpected prompt: ${question}`);
      return next;
    },
  };
}

function stubDeps(overrides: Partial<WizardDependencies> = {}): {
  deps: WizardDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: WizardDependencies = {
    installSkills: async () => { calls.push('installSkills'); },
    discover: async () => {
      calls.push('discover');
      return { executionCount: 3 };
    },
    assessmentArtifactExists: async () => {
      calls.push('assessmentArtifactExists');
      return true;
    },
    hasProviderCredential: () => {
      calls.push('hasProviderCredential');
      return false;
    },
    validate: async () => { calls.push('validate'); },
    sync: async () => {
      calls.push('sync');
      return { runId: 'run-1' };
    },
    ...overrides,
  };
  return { deps, calls };
}

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'glirastes-wizard-'));
}

describe('setup invocation', () => {
  it('runs the wizard only when no subcommand was given', () => {
    expect(isWizardInvocation([])).toBe(true);
    expect(isWizardInvocation(['--host', 'claude'])).toBe(true);
    expect(isWizardInvocation(['scan'])).toBe(false);
    expect(isWizardInvocation(['sync'])).toBe(false);
    expect(isWizardInvocation(['status', '--run-id', 'x'])).toBe(false);
  });
});

describe('the guided flow', () => {
  it('walks skills, scan, assessment, validate and sync in order', async () => {
    const { deps, calls } = stubDeps();
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    });

    expect(calls.filter((c) => c !== 'hasProviderCredential')).toEqual([
      'installSkills',
      'discover',
      'assessmentArtifactExists',
      'validate',
      'sync',
    ]);
    expect(result.runId).toBe('run-1');
  });

  it('completes the default path with no provider credential', async () => {
    const { deps } = stubDeps({ hasProviderCredential: () => false });
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    });

    expect(result.runId).toBe('run-1');
  });
});

describe('non-interactive use', () => {
  it('names every missing flag instead of prompting', async () => {
    const io = recordingIo();
    const { deps } = stubDeps();

    await expect(runSetupWizard({
      rootDir: await freshRoot(),
      io,
      deps,
    })).rejects.toThrow(/--host[\s\S]*--assessment/);

    expect(io.lines.filter((line) => line.endsWith('? '))).toEqual([]);
  });

  it('accepts a complete flag set without a terminal', async () => {
    const { deps } = stubDeps();
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      host: 'codex',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    });

    expect(result.runId).toBe('run-1');
  });
});

describe('autonomous assessment', () => {
  it('explains the egress, links the provider and stops without a credential', async () => {
    const io = recordingIo();
    const { deps, calls } = stubDeps({ hasProviderCredential: () => false });

    await expect(runSetupWizard({
      rootDir: await freshRoot(),
      io,
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'autonomous',
      deps,
    })).rejects.toBeInstanceOf(WizardStopped);

    const printed = io.lines.join('\n');
    expect(printed).toContain('https://openrouter.ai/keys');
    expect(printed).toMatch(/leaves? (your|the) machine/i);
    expect(calls).not.toContain('sync');
  });

  it('proceeds when a credential is present', async () => {
    const { deps } = stubDeps({ hasProviderCredential: () => true });
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'autonomous',
      deps,
    });

    expect(result.runId).toBe('run-1');
  });
});

describe('resumability', () => {
  it('continues after the assessment instead of restarting', async () => {
    const rootDir = await freshRoot();
    const first = stubDeps({ assessmentArtifactExists: async () => false });

    await expect(runSetupWizard({
      rootDir,
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps: first.deps,
    })).rejects.toBeInstanceOf(WizardStopped);

    expect(first.calls).toContain('discover');
    expect(first.calls).not.toContain('sync');

    const second = stubDeps();
    const result = await runSetupWizard({
      rootDir,
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps: second.deps,
    });

    // The finished steps do not run again.
    expect(second.calls).not.toContain('installSkills');
    expect(second.calls).not.toContain('discover');
    expect(result.runId).toBe('run-1');
  });

  it('never creates a second setup run', async () => {
    const rootDir = await freshRoot();
    const { deps, calls } = stubDeps();
    const options = {
      rootDir,
      io: recordingIo(),
      host: 'claude' as const,
      parts: ['tools' as const],
      assessmentMode: 'interview' as const,
      deps,
    };

    const first = await runSetupWizard(options);
    const second = await runSetupWizard(options);

    expect(calls.filter((c) => c === 'sync')).toHaveLength(1);
    expect(second.runId).toBe(first.runId);
  });

  it('records its progress where a later run can read it', async () => {
    const rootDir = await freshRoot();
    const { deps } = stubDeps();
    await runSetupWizard({
      rootDir,
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    });

    const state = JSON.parse(
      await readFile(join(rootDir, WIZARD_STATE_PATH), 'utf8'),
    ) as { completed: string[]; runId?: string };

    expect(state.completed).toContain('sync');
    expect(state.runId).toBe('run-1');
  });

  it('refuses to act on a state file it cannot understand', async () => {
    const rootDir = await freshRoot();
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'fixture' }),
      'utf8',
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(rootDir, '.glirastes'), { recursive: true });
    await writeFile(
      join(rootDir, WIZARD_STATE_PATH),
      JSON.stringify({ schemaVersion: 99 }),
      'utf8',
    );

    const { deps } = stubDeps();
    await expect(runSetupWizard({
      rootDir,
      io: recordingIo(),
      host: 'claude',
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    })).rejects.toThrow();
  });
});

describe('interactive use', () => {
  it('asks for host and assessment mode when they were not given', async () => {
    const io = recordingIo(['claude', 'interview']);
    const { deps } = stubDeps();

    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    });

    expect(result.runId).toBe('run-1');
    expect(io.lines.join('\n')).toMatch(/host/i);
    expect(io.lines.join('\n')).toMatch(/interview|autonomous/i);
  });

  it('rejects an answer that is not one of the offered choices', async () => {
    const io = recordingIo(['emacs']);
    const { deps } = stubDeps();

    await expect(runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    })).rejects.toThrow(/emacs/);
  });
});
