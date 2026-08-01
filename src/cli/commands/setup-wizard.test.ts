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
      hosts: ['claude'],
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
      hosts: ['claude'],
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

    const failure = await runSetupWizard({
      rootDir: await freshRoot(),
      io,
      deps,
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('--host');
    expect((failure as Error).message).toContain('--assessment');

    expect(io.lines.filter((line) => line.endsWith('? '))).toEqual([]);
  });

  it('accepts a complete flag set without a terminal', async () => {
    const { deps } = stubDeps();
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      hosts: ['codex'],
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
      hosts: ['claude'],
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
      hosts: ['claude'],
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
      hosts: ['claude'],
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
      hosts: ['claude'],
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
      hosts: ['claude' as const],
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
      hosts: ['claude'],
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
      hosts: ['claude'],
      parts: ['tools'],
      assessmentMode: 'interview',
      deps,
    })).rejects.toThrow();
  });
});

describe('interactive use', () => {
  it('asks for the assessment mode and then the hosts', async () => {
    const io = recordingIo(['interview', 'claude']);
    const { deps } = stubDeps();

    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    });

    expect(result.runId).toBe('run-1');
    expect(io.lines.join('\n')).toMatch(/interview|autonomous|manual/i);
    expect(io.lines.join('\n')).toMatch(/hosts/i);
  });

  it('accepts several hosts at once', async () => {
    const io = recordingIo(['interview', 'claude, codex']);
    let received: ReadonlyArray<string> = [];
    const { deps } = stubDeps({
      installSkills: async ({ hosts }) => { received = hosts; },
    });

    await runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    });

    expect(received).toEqual(['claude', 'codex']);
  });

  it('rejects an answer that is not one of the offered choices', async () => {
    const io = recordingIo(['interview', 'emacs']);
    const { deps } = stubDeps();

    await expect(runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    })).rejects.toThrow(/emacs/);
  });

  it('does not ask for a host in manual mode, where no skill is installed', async () => {
    const io = recordingIo(['manual']);
    const { deps, calls } = stubDeps();

    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      deps,
    });

    expect(result.runId).toBe('run-1');
    expect(calls).not.toContain('installSkills');
  });
});

describe('the setup skill follows from the assessment mode', () => {
  it.each(['interview', 'autonomous'] as const)(
    'installs it for %s without being asked',
    async (assessmentMode) => {
      let received: ReadonlyArray<string> = [];
      const { deps } = stubDeps({
        hasProviderCredential: () => true,
        installSkills: async ({ parts }) => { received = parts; },
      });

      await runSetupWizard({
        rootDir: await freshRoot(),
        io: recordingIo(),
        hosts: ['claude'],
        parts: ['tools'],
        assessmentMode,
        deps,
      });

      // Both modes are carried out by the skill, so there is nothing to choose.
      expect(received).toContain('setup');
      expect(received).toContain('tools');
    },
  );

  it('leaves it out in manual mode', async () => {
    let received: ReadonlyArray<string> = [];
    const { deps } = stubDeps({
      installSkills: async ({ parts }) => { received = parts; },
    });

    await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      hosts: ['claude'],
      parts: ['tools'],
      assessmentMode: 'manual',
      deps,
    });

    expect(received).not.toContain('setup');
  });

  it('tells a manual operator where the contract is documented', async () => {
    const io = recordingIo();
    const { deps } = stubDeps({ assessmentArtifactExists: async () => false });

    await expect(runSetupWizard({
      rootDir: await freshRoot(),
      io,
      parts: ['tools'],
      assessmentMode: 'manual',
      deps,
    })).rejects.toBeInstanceOf(WizardStopped);

    expect(io.lines.join('\n')).toContain('setting-up-glirastes');
  });

  it('needs no host in manual mode without a terminal', async () => {
    const { deps } = stubDeps();
    const result = await runSetupWizard({
      rootDir: await freshRoot(),
      io: recordingIo(),
      parts: ['tools'],
      assessmentMode: 'manual',
      deps,
    });

    expect(result.runId).toBe('run-1');
  });
});
