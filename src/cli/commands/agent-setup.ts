import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { scaffoldToolsInputs, type InitScaffold } from './init-scaffold.js';
import { findPackageSkillsDir, installSkills } from './install-skills.js';
import { hostRecord, readInstalledSkillsManifest } from './installed-skills-manifest.js';
import { inspectSetupProject } from './project-inspection.js';
import { createDoctorReport, formatDoctorReport } from './doctor.js';

type AgentHost = 'codex' | 'claude';
interface AvailableAgent { host: AgentHost; executable: string }
export interface AgentLaunchRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export interface AgentSetupDependencies {
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
  ask?: (question: string) => Promise<string>;
  available?: () => Promise<AvailableAgent[]>;
  launch?: (request: AgentLaunchRequest) => Promise<number>;
}

const TARGETS = { codex: '.agents/skills', claude: '.claude/skills' } as const;
function failure(message: string, remediation: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({ code: 'E-SETUP-020', operation: 'setup.agent', message, remediation });
}

async function availableAgents(env: NodeJS.ProcessEnv): Promise<AvailableAgent[]> {
  const result: AvailableAgent[] = [];
  // Relative PATH entries could select a project-supplied executable by accident.
  const paths = (env.PATH ?? '').split(delimiter).filter(isAbsolute);
  for (const host of ['codex', 'claude'] as const) {
    for (const path of paths) {
      const executable = join(path, host);
      try {
        await access(executable, constants.X_OK);
        if (!(await lstat(await realpath(executable))).isFile()) continue;
        result.push({ host, executable });
        break;
      } catch { /* This PATH entry does not provide the selected CLI. */ }
    }
  }
  return result;
}

export function launchSetupAgent(request: AgentLaunchRequest): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, env: request.env, stdio: 'inherit', shell: false,
    });
    child.once('error', () => reject(failure('The selected coding agent could not start.', 'check-selected-agent')));
    child.once('close', (code) => resolveExit(code ?? 1));
  });
}

async function assertLocalInstallPaths(root: string, host: AgentHost): Promise<void> {
  const target = TARGETS[host];
  for (const path of ['.glirastes', '.glirastes/installed-skills.json', target.split('/')[0], target]) {
    try {
      if ((await lstat(join(root, path))).isSymbolicLink()) {
        throw failure('Review linked setup or skill folders before installing.', 'review-setup-write-paths');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const record = hostRecord(await readInstalledSkillsManifest(root), host);
  if (record && resolve(root, record.target) !== resolve(root, target)) {
    throw failure('The recorded skills use a different installation folder. Preserve it and review the target.', 'review-setup-write-paths');
  }
}

export async function runAgentSetup(options: {
  rootDir: string;
  agent?: string;
  dryRun?: boolean;
  json?: boolean;
  managed?: boolean;
}, deps: AgentSetupDependencies = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (env.GLIRASTES_SETUP_AGENT_ACTIVE) {
    throw failure('Continue the current integration with setup and doctor; do not start init recursively.', 'continue-current-setup');
  }
  if (options.agent && options.agent !== 'codex' && options.agent !== 'claude') {
    throw failure('Choose one verified setup launcher: --agent codex or --agent claude.', 'choose-setup-agent');
  }
  const active: AgentHost | undefined = env.CODEX_THREAD_ID && !env.CLAUDECODE
    ? 'codex' : env.CLAUDECODE && !env.CODEX_THREAD_ID ? 'claude' : undefined;
  const interactive = deps.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const available = await (deps.available ?? (() => availableAgents(env)))();
  let agent = options.agent as AgentHost | undefined ?? active;
  if (!agent && available.length === 1) agent = available[0].host;
  if (!agent && !options.json && interactive && deps.ask && available.length > 1) {
    const answer = (await deps.ask(`Which existing coding agent should set up this app (${available.map((item) => item.host).join(' / ')})? `)).trim();
    if (available.some((item) => item.host === answer)) agent = answer as AgentHost;
  }
  if (!agent) throw failure('Select your existing coding agent with --agent codex or --agent claude.', 'choose-setup-agent');
  if (!options.dryRun && (env.CODEX_THREAD_ID || env.CLAUDECODE) && active !== agent) {
    throw failure('Continue with the current coding agent, or start the other agent from a separate terminal. No files were changed.', 'use-current-agent-session');
  }
  const selected = available.find((item) => item.host === agent);
  if (!selected && active !== agent) throw failure('Install or sign in to the selected coding agent, then run init again. No other provider was selected.', 'install-selected-agent');
  if (!options.dryRun && active !== agent && !interactive) {
    throw failure('Run init in your coding-agent session or an interactive terminal. No files were changed.', 'use-interactive-agent');
  }
  if (!options.dryRun && active !== agent && options.json) {
    throw failure('Interactive agents write their own terminal output. Omit --json, or use --dry-run --json for a machine-readable preview. No files were changed.', 'use-interactive-output');
  }
  const root = await realpath(resolve(options.rootDir));
  const inspection = await inspectSetupProject(root);
  await assertLocalInstallPaths(root, agent);
  const bundled = findPackageSkillsDir();
  const instructions = [
    'Complete the Glirastes integration in this app and verify a successful authorized tool action.',
    `App folder: ${JSON.stringify(root)}. SDK package used by this command: ${JSON.stringify(resolve(bundled, '..'))}.`,
    `Read the full bundled workflow at ${JSON.stringify(join(bundled, 'setting-up-glirastes/SKILL.md'))}, including its required references, before editing.`,
    'Use this exact SDK package/API surface; do not substitute an unrelated same-version registry package.',
    'Inspect the app code for frontend, backend, schemas, navigation, filters and server-side authorization. Manifest detection alone is not integration proof.',
    'Preserve modified installed skills and all existing app changes. Reconcile their project-specific instructions with the bundled workflow; never force-replace them.',
    'Use the current agent and its existing model configuration; do not request an extra setup provider key or silently change provider.',
    'The app chat needs its own authorized runtime model binding. Do not extract coding-agent credentials for app use.',
    'Continue autonomously from existing evidence. Ask only genuinely unresolved decisions. Create source-derived local bindings, chat integration and repeatable build/CI regeneration; do not ask the developer to maintain a second tool catalogue.',
    'Init wrote .glirastes/tools.json, .glirastes/prompt-bundle.json, the predev/prebuild scripts and the agent hint where they were missing. Run glirastes tools refresh, work through glirastes tools resolve --print and glirastes tools describe --print, then glirastes tools refresh and glirastes tools eval again. Never change the appId in tools.json.',
    options.managed
      ? 'Managed mode is explicit: existing Managed apps retain --managed for setup and doctor. For a fresh app, prepare local pairing artifacts, connect with approval, then apply Managed setup before any chat/tool execution. Preserve app/environment scope; never downgrade an existing Managed app.'
      : 'A fresh app defaults to Standalone without a Platform account. Preserve any existing Connected/Managed configuration; never silently downgrade it.',
    'Keep final authorization and business data local. No unsigned fallback, blanket approval removal, secret logging, push, merge, publication or deployment.',
    'Run local setup/doctor and the actual chat/tool test. Report separately what passed and what is blocked; agent exit or Doctor success is not tool-action proof. Do not run glirastes init again inside this setup.',
  ].join('\n');
  const base = { schemaVersion: 1, agent, instructions, inspection };
  const scaffoldText = (scaffold: InitScaffold, verb: string) => [
    scaffold.written.length > 0 ? `${verb}: ${scaffold.written.join(', ')}` : 'No Glirastes input files were missing.',
    ...scaffold.notes,
  ].join('\n');
  if (options.dryRun) {
    const scaffold = await scaffoldToolsInputs({ root, host: agent, dryRun: true });
    const preview = { ...base, status: 'preview', skillDirectory: TARGETS[agent], scaffold };
    console.log(options.json ? JSON.stringify(preview)
      : `Glirastes setup preview (${agent})\nNo files changed or agent started.\n${scaffoldText(scaffold, 'Would write')}\n${instructions}`);
    return;
  }
  await installSkills({ rootDir: root, host: agent, parts: ['setup', 'tools', 'chat-ui', 'framework'], quiet: options.json });
  const scaffold = await scaffoldToolsInputs({ root, host: agent });
  if (active === agent) {
    console.log(options.json ? JSON.stringify({ ...base, status: 'continue-in-session', scaffold })
      : `${scaffoldText(scaffold, 'Wrote')}\nContinue setup in this ${agent} session:\n${instructions}`);
    return;
  }
  console.log(scaffoldText(scaffold, 'Wrote'));
  console.log(`Starting ${agent} in the app folder with its existing model and permission settings.`);
  const exitCode = await (deps.launch ?? launchSetupAgent)({
    executable: selected!.executable, args: [instructions], cwd: root,
    env: { ...env, GLIRASTES_SETUP_AGENT_ACTIVE: '1' },
  });
  if (exitCode !== 0) {
    throw failure('The coding agent stopped before setup verification. Existing work was preserved; resume it in your agent.', 'resume-selected-agent');
  }
  const doctor = await createDoctorReport({ rootDir: root, managed: options.managed, env });
  console.log(options.json ? JSON.stringify({ schemaVersion: 1, status: 'agent-exited', doctor }) : formatDoctorReport(doctor));
  if (doctor.status === 'fail' || doctor.counts.tools === 0) process.exitCode = 1;
}
