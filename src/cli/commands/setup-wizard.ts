import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { installSkills } from './install-skills.js';
import {
  detectStack,
  proposeParts,
  INSTALLER_PARTS,
  PART_LABELS,
  type InstallerPart,
} from './installer-parts.js';

/** Where the wizard remembers how far it got. */
export const WIZARD_STATE_PATH = '.glirastes/setup-wizard-state.json';

export const WIZARD_STEPS = [
  'skills',
  'scan',
  'assess',
  'validate',
  'sync',
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];
export type InstallHost = 'codex' | 'claude' | 'gemini';

export const INSTALL_HOSTS = ['codex', 'claude', 'gemini'] as const;

/**
 * How the tool descriptions, roles and prompt groups get written.
 *
 * `interview` and `autonomous` are both carried out by the setup skill, so both
 * require it — there is nothing to choose. `manual` is the way out for an
 * operator who writes the artifact themselves, and is the only mode where the
 * setup skill is genuinely optional.
 */
export const ASSESSMENT_MODES = [
  'interview',
  'autonomous',
  'manual',
] as const;

export type AssessmentMode = (typeof ASSESSMENT_MODES)[number];

/** Whether this mode is carried out by the setup skill. */
export function requiresSetupSkill(mode: AssessmentMode): boolean {
  return mode === 'interview' || mode === 'autonomous';
}

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
    hosts: ReadonlyArray<InstallHost>;
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
  /** One or several agent hosts. */
  hosts?: ReadonlyArray<InstallHost>;
  parts?: ReadonlyArray<InstallerPart>;
  assessmentMode?: AssessmentMode;
  deps: WizardDependencies;
}

export interface SetupWizardResult {
  runId: string;
}

/** The legacy interview is available only through `setup guided`. */
export function isWizardInvocation(rest: ReadonlyArray<string>): boolean {
  return rest[0] === 'guided';
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
async function chooseMany<T extends string>(
  io: WizardIo,
  question: string,
  choices: ReadonlyArray<T>,
): Promise<T[]> {
  const answer = await io.ask(
    `${question} (${choices.join(' | ')}, comma-separated) ? `,
  );
  const picked = answer
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (picked.length === 0) {
    throw new Error(`Choose at least one of: ${choices.join(', ')}.`);
  }
  const unknown = picked.filter(
    (value) => !(choices as ReadonlyArray<string>).includes(value),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.map((value) => `'${value}'`).join(', ')} is not one of: `
      + `${choices.join(', ')}.`,
    );
  }
  return [...new Set(picked)] as T[];
}

async function resolveChoices(
  options: SetupWizardOptions,
): Promise<{ hosts: InstallHost[]; mode: AssessmentMode }> {
  const { io } = options;
  const givenHosts = options.hosts?.length ? [...options.hosts] : undefined;

  if (!io.isInteractive) {
    // The installer asks rather than taking flags, so without a terminal there
    // is nothing it can fall back to.
    const needsHosts = options.assessmentMode
      ? requiresSetupSkill(options.assessmentMode)
      : true;
    if (!options.assessmentMode || (needsHosts && !givenHosts)) {
      throw new Error(
        'glirastes setup asks how you want the app assessed and which agent '
        + 'hosts to serve. Run it from a terminal.',
      );
    }
    return { hosts: givenHosts ?? [], mode: options.assessmentMode };
  }

  const mode = options.assessmentMode
    ?? await choose(
      io,
      'Write the tool descriptions and prompts by interview, autonomously, '
      + 'or manually',
      ASSESSMENT_MODES,
    );

  // Interview and autonomous are both carried out by the setup skill, so the
  // host question only arises once a mode that needs one is chosen.
  if (!requiresSetupSkill(mode)) {
    return { hosts: givenHosts ?? [], mode };
  }

  const hosts = givenHosts
    ?? await chooseMany(
      io,
      'Which agent hosts should receive the skills',
      INSTALL_HOSTS,
    );
  return { hosts, mode };
}

/**
 * Show the selection derived from the project and let the operator edit it.
 *
 * The setup part is never in the list: it follows from the assessment mode, and
 * offering it would invite declining the thing that performs the chosen step.
 */
async function resolveParts(
  options: SetupWizardOptions,
  mode: AssessmentMode,
): Promise<InstallerPart[]> {
  const { io, rootDir } = options;
  let chosen: InstallerPart[];

  if (options.parts) {
    chosen = [...options.parts];
  } else if (!io.isInteractive) {
    chosen = proposeParts(await detectStack(rootDir));
  } else {
    const proposed = proposeParts(await detectStack(rootDir));
    io.log('');
    io.log('Skills to install:');
    for (const part of proposed) {
      io.log(`  - ${PART_LABELS[part]}`);
    }
    const answer = (await io.ask(
      'Take all of these? (yes, or name the ones you want, comma-separated) ? ',
    )).trim().toLowerCase();

    if (answer === '' || answer === 'y' || answer === 'yes') {
      chosen = proposed;
    } else {
      const named = answer.split(',').map((value) => value.trim()).filter(Boolean);
      const unknown = named.filter(
        (value) => !(INSTALLER_PARTS as ReadonlyArray<string>).includes(value),
      );
      if (unknown.length > 0) {
        throw new Error(
          `${unknown.map((value) => `'${value}'`).join(', ')} is not one of: `
          + `${INSTALLER_PARTS.join(', ')}.`,
        );
      }
      chosen = named as InstallerPart[];
    }
  }

  if (requiresSetupSkill(mode) && !chosen.includes('setup')) {
    chosen.push('setup');
  }
  return chosen;
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

  const { hosts, mode } = await resolveChoices(options);

  if (!done('skills')) {
    const parts = await resolveParts(options, mode);
    if (hosts.length > 0 && parts.length > 0) {
      await deps.installSkills({ rootDir, hosts, parts });
    }
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
      if (mode === 'manual') {
        io.log(
          'Write the setup artifact yourself, then run setup again — it '
          + 'continues from here. The contract is documented in the '
          + 'setting-up-glirastes skill. Re-run setup and choose interview '
          + 'or autonomous if you would rather have it do the work.',
        );
      } else {
        io.log(
          `Run the setting-up-glirastes skill in ${hosts.join(' or ')} to `
          + 'assess the scan, curate the tool descriptions, propose roles, '
          + 'and draft the prompt groups.',
        );
        io.log('Then run setup again — it continues from here.');
      }
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
    installSkills: async ({ rootDir, hosts, parts }) => {
      await installSkills({ rootDir, hosts, parts });
    },
    hasProviderCredential: () =>
      Boolean(process.env.OPENROUTER_API_KEY?.trim()),
  };
}
