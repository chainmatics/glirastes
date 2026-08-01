import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { installSkills } from './install-skills.js';
import { type InstallerPart } from './installer-parts.js';

/** Where the wizard remembers how far it got. */
export const WIZARD_STATE_PATH = '.glirastes/setup-wizard-state.json';

/** Sub-commands that stay scriptable single steps. */
const SUBCOMMANDS = ['scan', 'sync', 'status'] as const;

export const WIZARD_STEPS = [
  'skills',
  'scan',
  'assess',
  'validate',
  'sync',
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];
export type InstallHost = 'codex' | 'claude' | 'gemini';
export type AssessmentMode = 'interview' | 'autonomous';

const WizardStateSchema = z.object({
  schemaVersion: z.literal(1),
  completed: z.array(z.enum(WIZARD_STEPS)),
  runId: z.string().min(1).optional(),
}).strict();

type WizardState = z.infer<typeof WizardStateSchema>;

/**
 * The wizard stopped on purpose and the operator has something to do before it
 * can continue. Distinct from a failure: re-running resumes.
 */
export class WizardStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WizardStopped';
  }
}

export interface WizardIo {
  isInteractive: boolean;
  log(message: string): void;
  ask(question: string): Promise<string>;
}

export interface WizardDependencies {
  installSkills(options: {
    rootDir: string;
    host: InstallHost;
    parts: ReadonlyArray<InstallerPart>;
  }): Promise<void>;
  discover(rootDir: string): Promise<{ executionCount: number }>;
  /** Whether the assessment has produced its artifact yet. */
  assessmentArtifactExists(rootDir: string): Promise<boolean>;
  /** Whether a provider credential for autonomous assessment is configured. */
  hasProviderCredential(): boolean;
  validate(rootDir: string): Promise<void>;
  sync(rootDir: string): Promise<{ runId: string }>;
}

export interface SetupWizardOptions {
  rootDir: string;
  io: WizardIo;
  host?: InstallHost;
  parts?: ReadonlyArray<InstallerPart>;
  assessmentMode?: AssessmentMode;
  deps: WizardDependencies;
}

export interface SetupWizardResult {
  runId: string;
}

/** Bare `glirastes setup` is the wizard; anything else is a single step. */
export function isWizardInvocation(rest: ReadonlyArray<string>): boolean {
  const first = rest[0];
  if (first === undefined) return true;
  return !(SUBCOMMANDS as ReadonlyArray<string>).includes(first);
}

async function readState(rootDir: string): Promise<WizardState> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, WIZARD_STATE_PATH), 'utf8');
  } catch {
    return { schemaVersion: 1, completed: [] };
  }
  // A state file we cannot read is an error, not an empty slate: continuing
  // would repeat steps that may already have created a setup run.
  return WizardStateSchema.parse(JSON.parse(raw));
}

async function writeState(
  rootDir: string,
  state: WizardState,
): Promise<void> {
  const absolute = join(rootDir, WIZARD_STATE_PATH);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function choose<T extends string>(
  io: WizardIo,
  question: string,
  choices: ReadonlyArray<T>,
): Promise<T> {
  const answer = (await io.ask(
    `${question} (${choices.join(' | ')}) ? `,
  )).trim().toLowerCase();
  if (!(choices as ReadonlyArray<string>).includes(answer)) {
    throw new Error(
      `'${answer}' is not one of: ${choices.join(', ')}.`,
    );
  }
  return answer as T;
}

/**
 * Resolve what the wizard needs. Interactive runs ask; non-interactive runs must
 * be given everything, and are told precisely what is missing rather than being
 * prompted into a hang.
 */
async function resolveChoices(
  options: SetupWizardOptions,
): Promise<{ host: InstallHost; mode: AssessmentMode }> {
  const { io } = options;
  if (!io.isInteractive) {
    const missing: string[] = [];
    if (!options.host) missing.push('--host');
    if (!options.assessmentMode) missing.push('--assessment');
    if (missing.length > 0) {
      throw new Error(
        `Interactive input is unavailable. Pass ${missing.join(' and ')}.`,
      );
    }
    return { host: options.host!, mode: options.assessmentMode! };
  }

  const host = options.host
    ?? await choose(io, 'Which agent host runs the setup skill', [
      'codex',
      'claude',
      'gemini',
    ] as const);
  const mode = options.assessmentMode
    ?? await choose(
      io,
      'Assess the application by interview or autonomously',
      ['interview', 'autonomous'] as const,
    );
  return { host, mode };
}

export async function runSetupWizard(
  options: SetupWizardOptions,
): Promise<SetupWizardResult> {
  const { rootDir, io, deps } = options;
  const state = await readState(rootDir);
  const done = (step: WizardStep): boolean => state.completed.includes(step);
  const complete = async (step: WizardStep): Promise<void> => {
    if (!state.completed.includes(step)) state.completed.push(step);
    await writeState(rootDir, state);
  };

  const { host, mode } = await resolveChoices(options);

  if (!done('skills')) {
    await deps.installSkills({
      rootDir,
      host,
      parts: options.parts ?? ['tools'],
    });
    await complete('skills');
  }

  if (!done('scan')) {
    const { executionCount } = await deps.discover(rootDir);
    io.log(`Discovered ${executionCount} local executions.`);
    await complete('scan');
  }

  if (!done('assess')) {
    if (mode === 'autonomous' && !deps.hasProviderCredential()) {
      io.log('');
      io.log(
        'Autonomous assessment needs a model of its own. The assessment '
        + 'prompt and the minimum source context it selects leave your machine '
        + 'and go directly to the provider under your own agreement. The '
        + 'Glirastes Platform is never a proxy and receives none of it.',
      );
      io.log('Get a key at https://openrouter.ai/keys, then run setup again.');
      io.log(
        'Alternatively re-run with --assessment interview, which needs no key '
        + 'and no egress at all.',
      );
      throw new WizardStopped('Autonomous assessment has no provider credential.');
    }

    if (!await deps.assessmentArtifactExists(rootDir)) {
      io.log('');
      io.log(
        `Run the setting-up-glirastes skill in ${host} to assess the scan, `
        + 'curate the tool descriptions, propose roles, and draft the prompt '
        + 'groups.',
      );
      io.log('Then run setup again — it continues from here.');
      throw new WizardStopped('The assessment artifact does not exist yet.');
    }
    await complete('assess');
  }

  if (!done('validate')) {
    await deps.validate(rootDir);
    await complete('validate');
  }

  if (!done('sync')) {
    const { runId } = await deps.sync(rootDir);
    state.runId = runId;
    await complete('sync');
  }

  if (!state.runId) {
    throw new Error('The wizard completed without recording a setup run.');
  }
  io.log(`Setup run ${state.runId} is synced.`);
  return { runId: state.runId };
}

/** Default dependencies, wired to the real commands. */
export function defaultWizardDependencies(): Pick<
  WizardDependencies,
  'installSkills' | 'hasProviderCredential'
> {
  return {
    installSkills: async ({ rootDir, host, parts }) => {
      await installSkills({ rootDir, host, parts });
    },
    hasProviderCredential: () =>
      Boolean(process.env.OPENROUTER_API_KEY?.trim()),
  };
}
