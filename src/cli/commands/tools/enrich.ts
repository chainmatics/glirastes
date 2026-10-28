import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import {
  BOT_MARKER,
  execFileRunner,
  GitCommandError,
  GitRepository,
  loopGuard,
  pathViolations,
  type Exec,
} from '../../../agent/git.js';
import { createJobModel, ModelAccessError, selectJobModel, type CreateOpenAI } from '../../../agent/openrouter.js';
import {
  PlatformToolJobs,
  TOOL_JOB_ITEM_LIMIT,
  ToolJobRequestError,
  type ToolJobItem,
  type ToolJobLedger,
  type ToolJobOutcome,
} from '../../../agent/platform-jobs.js';
import { runSkillJob, type JobSkill, type RefreshSummary, type SkillJobResult } from '../../../agent/runner.js';
import { Workspace } from '../../../agent/workspace.js';
import { loadToolsConfig, TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { evaluateRouting } from '../../../codegen/tools/routing-eval.js';
import { requiredLanguages } from '../../../codegen/tools/semantics.js';
import { buildDescribeWorklist, buildResolveWorklist } from '../../../codegen/tools/worklist.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { findPackageSkillsDir } from '../install-skills.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

export const ENRICH_ARGS = { flags: ['--managed', '--first-run', '--json'], values: ['--root', '--base'] } as const;

/** The skills the local coding agent uses; the managed job runs exactly these (spec 4.6). */
export const MANAGED_JOB_SKILLS = ['maintaining-glirastes-tools', 'describing-glirastes-tools'] as const;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DISCOVERY_DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export interface EnrichDependencies {
  exec?: Exec;
  fetchImpl?: typeof fetch;
  /** Loads `@ai-sdk/openai` on demand; only `tools enrich --managed` ever does. */
  loadOpenAI?: () => Promise<CreateOpenAI>;
  now?: () => Date;
}

interface EnrichSummary {
  schemaVersion: 1;
  status: 'skipped' | 'finished' | 'failed';
  code?: string;
  jobId?: string;
  outcome?: ToolJobOutcome;
  commitSha?: string;
  pullRequest?: string;
  costUsd?: number | null;
  items?: Record<'total' | 'resolved' | 'described' | 'unchanged' | 'failed', number>;
}

async function loadOpenAI(): Promise<CreateOpenAI> {
  // A computed specifier: bundlers and `tools check` never load the provider.
  const specifier = '@ai-sdk/openai';
  const loaded = await import(specifier) as { createOpenAI: CreateOpenAI };
  return loaded.createOpenAI;
}

function report(io: ToolsIo, json: boolean, summary: EnrichSummary): number {
  if (json) {
    io.log(JSON.stringify(summary));
  } else {
    const detail = [summary.code, summary.outcome, summary.pullRequest ?? summary.commitSha].filter(Boolean).join(', ');
    io.log(`glirastes tools enrich: ${summary.status}${detail ? ` (${detail})` : ''}`);
  }
  return summary.status === 'failed' ? 1 : 0;
}

/** One job item per tool: its stage-1 findings for the agent plus its description gaps. */
export function jobItems(
  resolveItems: ReadonlyArray<{ stableKey: string; code: string; owner: string }>,
  describeItems: ReadonlyArray<{ stableKey: string; gaps: ReadonlyArray<string> }>,
): ToolJobItem[] {
  const gaps = new Map<string, Set<string>>();
  const add = (stableKey: string, code: string) => {
    if (!/^[\x20-\x7e]{1,300}$/.test(stableKey) || !/^[a-z][a-z0-9_.-]{1,63}$/.test(code)) return;
    const codes = gaps.get(stableKey) ?? new Set<string>();
    codes.add(code);
    gaps.set(stableKey, codes);
  };
  for (const item of resolveItems) if (item.owner === 'agent') add(item.stableKey, item.code);
  for (const item of describeItems) for (const gap of item.gaps) add(item.stableKey, gap);
  return [...gaps.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, TOOL_JOB_ITEM_LIMIT)
    .map(([stableKey, codes]) => ({ stableKey, gaps: [...codes].sort().slice(0, 20) }));
}

async function readSkills(): Promise<JobSkill[]> {
  const dir = findPackageSkillsDir();
  return Promise.all(MANAGED_JOB_SKILLS.map(async (name) => ({
    name,
    text: await readFile(join(dir, name, 'SKILL.md'), 'utf8'),
  })));
}

async function currentBranch(exec: Exec, root: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fromCi = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (fromCi) return fromCi;
  const result = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== 'HEAD' ? branch : undefined;
}

export async function runToolsEnrich(
  argv: ReadonlyArray<string>,
  io: ToolsIo,
  deps: EnrichDependencies = {},
): Promise<number> {
  const args = parseToolArgs(argv, ENRICH_ARGS);
  if (!args.flags.has('--managed')) {
    throw new ToolsUsageError(
      'tools enrich runs the managed Pro job in CI. Locally your coding agent works the list of glirastes tools describe --print.',
    );
  }
  const json = args.flags.has('--json');
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const base = args.values.get('--base') ?? 'main';
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? execFileRunner;
  const started = now().getTime();

  // The CI key and the BYOK key come from the CI secrets; the app's own
  // OPENROUTER_API_KEY (its chat) is never read here.
  const ciKey = io.env.GLIRASTES_CI_KEY?.trim();
  const baseUrl = io.env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  if (!ciKey || !baseUrl) return report(io, json, { schemaVersion: 1, status: 'failed', code: 'managed_config_missing' });
  const config = loadToolsConfig(root);
  const repository = new GitRepository(root, exec);
  const head = await repository.head();
  const branch = await currentBranch(exec, root, io.env);
  if (!branch || !BRANCH.test(branch) || !BRANCH.test(base)) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'branch_unknown' });
  }

  const worklists = async () => {
    const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
    const resolveList = buildResolveWorklist(result);
    const describeList = buildDescribeWorklist(result, {
      root,
      locale: config.locale,
      languages: requiredLanguages(config.locale),
      writeContracts: config.enrich.writeContracts === true,
    });
    return { result, resolveList, describeList, items: jobItems(resolveList.items, describeList.items) };
  };
  const before = await worklists();
  const skip = loopGuard(head, before.items.length);
  if (skip) return report(io, json, { schemaVersion: 1, status: 'skipped', code: skip });

  // Only generator outputs may differ from the commit before the job starts.
  const generated = new Set(Object.keys(before.result.outputs));
  const allowed = {
    files: new Set([...generated, TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics]),
    directories: [] as string[],
  };
  if (pathViolations(await repository.changedPaths(), allowed).length > 0) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'worktree_dirty' });
  }
  const artifact = JSON.parse(before.result.outputs[TOOLS_PATHS.setupArtifact] ?? '{}') as { discoveryDigest?: unknown };
  if (typeof artifact.discoveryDigest !== 'string' || !DISCOVERY_DIGEST.test(artifact.discoveryDigest)) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'setup_artifact_missing' });
  }

  const jobs = new PlatformToolJobs({ baseUrl, appId: config.appId, ciKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  let grant;
  try {
    grant = await jobs.create({
      schemaVersion: 1,
      discoveryDigest: artifact.discoveryDigest,
      commitSha: head.sha,
      branch,
      firstRun: args.flags.has('--first-run'),
      items: before.items,
    });
  } catch (error) {
    if (error instanceof ToolJobRequestError) {
      return report(io, json, { schemaVersion: 1, status: error.productRefusal ? 'skipped' : 'failed', code: error.code });
    }
    throw error;
  }

  // From here on every path reports a ledger, so the Platform can revoke the key.
  const items = before.items;
  const ledger = async (outcome: ToolJobOutcome, input: {
    reasonCode?: string;
    run?: SkillJobResult;
    model?: string;
    committed?: string[];
    commitSha?: string;
    pullRequest?: string;
    states?: ToolJobLedger['items'];
  } = {}): Promise<EnrichSummary> => {
    const served = input.run?.servedModel;
    const body: ToolJobLedger = {
      schemaVersion: 1,
      outcome,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      model: served && MODEL_ID.test(served) ? served : input.model ?? grant.model,
      repairRounds: input.run?.repairRounds ?? 0,
      durationMs: Math.min(3_600_000, Math.max(0, now().getTime() - started)),
      changedFiles: input.committed?.length ?? 0,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      usage: input.run?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      items: input.states ?? items.map((item) => ({ stableKey: item.stableKey, state: 'unchanged' as const })),
    };
    const receipt = await jobs.reportLedger(grant.jobId, body);
    const counts = { total: body.items.length, resolved: 0, described: 0, unchanged: 0, failed: 0 };
    for (const item of body.items) counts[item.state] += 1;
    return {
      schemaVersion: 1,
      status: outcome === 'failed' ? 'failed' : 'finished',
      ...(input.reasonCode ? { code: input.reasonCode } : {}),
      jobId: grant.jobId,
      outcome,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
      costUsd: receipt.costUsd,
      items: counts,
    };
  };
  const finish = async (outcome: ToolJobOutcome, input: Parameters<typeof ledger>[1] = {}) => {
    try {
      return report(io, json, await ledger(outcome, input));
    } catch (error) {
      if (error instanceof ToolJobRequestError) {
        return report(io, json, { schemaVersion: 1, status: 'failed', code: error.code, jobId: grant.jobId, outcome });
      }
      throw error;
    }
  };

  const apiKey = grant.openrouter?.apiKey ?? io.env.GLIRASTES_TOOLS_OPENROUTER_KEY?.trim();
  if (!apiKey) return finish('failed', { reasonCode: 'byok_key_missing' });
  const openRouterUrl = grant.openrouter?.baseUrl ?? OPENROUTER_BASE_URL;
  let model: LanguageModel;
  let modelId: string;
  try {
    const selected = await selectJobModel({
      baseUrl: openRouterUrl,
      apiKey,
      model: grant.model,
      fallbackModel: grant.fallbackModel,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    modelId = selected.model;
    const createOpenAI = await (deps.loadOpenAI ?? loadOpenAI)().catch(() => undefined);
    if (!createOpenAI) return finish('failed', { reasonCode: 'provider_package_missing' });
    model = createJobModel({
      createOpenAI,
      baseUrl: openRouterUrl,
      apiKey,
      model: modelId,
      routing: grant.routing,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (error) {
    if (error instanceof ModelAccessError) return finish('failed', { reasonCode: error.code });
    throw error;
  }

  const workspace = new Workspace({
    root,
    isIgnored: (paths) => repository.ignored(paths),
    writableFiles: [TOOLS_PATHS.resolutions, TOOLS_PATHS.semantics],
    creatableFiles: before.describeList.writeContracts
      ? before.describeList.items.flatMap((item) => (item.targets.contract ? [item.targets.contract.file] : []))
      : [],
  });
  const refresh = async (): Promise<RefreshSummary> => {
    const result = await io.runPipeline({ root, mode: 'write', keepGoing: true });
    for (const path of Object.keys(result.outputs)) allowed.files.add(path);
    return {
      findings: result.findings.slice(0, 200).map(({ code, subjectRef, message }) => ({ code, subjectRef, message })),
      changed: result.changes.added.length + result.changes.changed.length + result.changes.removed.length,
    };
  };
  const evaluate = async () => {
    const setup = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.enrich');
    const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.enrich');
    const evaluation = evaluateRouting({ artifact: setup, contracts: contracts.tools });
    return { failed: evaluation.summary.failed, failures: evaluation.tools.filter((tool) => tool.failures.length > 0).slice(0, 50) };
  };

  const run = await runSkillJob({
    model,
    modelId,
    skills: await readSkills(),
    worklists: { resolve: before.resolveList, describe: before.describeList },
    workspace,
    tools: { refresh, evaluate },
    budgetUsd: grant.budgetUsd,
    deadline: new Date(grant.expiresAt),
    now,
  });
  if (run.outcome === 'failed') return finish('failed', { reasonCode: run.reasonCode ?? 'model_error', run, model: modelId });
  if (!run.refresh) await refresh();

  for (const path of workspace.written) allowed.files.add(path);
  const changed = await repository.changedPaths();
  if (pathViolations(changed, allowed).length > 0) {
    return finish('failed', { reasonCode: 'path_violation', run, model: modelId });
  }

  const after = await worklists();
  const open = new Map(after.items.map((item) => [item.stableKey, new Set(item.gaps)]));
  const rejected = new Set((run.refresh?.findings ?? [])
    .filter((finding) => finding.code === 'resolution-rejected')
    .map((finding) => finding.subjectRef));
  const resolutionCodes = new Set(before.resolveList.items.map((item) => item.code));
  const states: ToolJobLedger['items'] = items.map((item) => {
    const remaining = open.get(item.stableKey) ?? new Set<string>();
    if (rejected.has(item.stableKey)) return { stableKey: item.stableKey, state: 'failed', reasonCode: 'resolution-rejected' };
    const closed = item.gaps.filter((gap) => !remaining.has(gap));
    if (closed.length === 0) return { stableKey: item.stableKey, state: 'unchanged' };
    const state = closed.some((gap) => resolutionCodes.has(gap)) ? 'resolved' : 'described';
    // Some gaps closed, others still open (e.g. a schema the job did not write).
    return closed.length < item.gaps.length
      ? { stableKey: item.stableKey, state, reasonCode: 'gaps-remaining' }
      : { stableKey: item.stableKey, state };
  });
  const outcomeOf = (committed: ToolJobOutcome): ToolJobOutcome => (run.outcome === 'completed' ? committed : run.outcome);
  if (changed.length === 0) {
    return finish(outcomeOf('no_change'), { ...(run.reasonCode ? { reasonCode: run.reasonCode } : {}), run, model: modelId, states });
  }

  const message = `chore(glirastes): describe tools ${BOT_MARKER}\n\nGlirastes-Job: ${grant.jobId}`;
  const reason = run.reasonCode ? { reasonCode: run.reasonCode } : {};
  try {
    if (branch === base) {
      // Started on the base branch: the bot never pushes there, it opens a pull request.
      const botBranch = `glirastes/tools-${head.sha.slice(0, 12)}`;
      await repository.switchToNewBranch(botBranch);
      const commitSha = await repository.commit(changed, message);
      await repository.push(botBranch);
      const pullRequest = await repository.openPullRequest({
        base,
        head: botBranch,
        title: `chore(glirastes): describe tools ${BOT_MARKER}`,
        body: `Glirastes job ${grant.jobId} wrote tool descriptions, schemas and their generated outputs. Review them, then run glirastes tools verify.`,
      });
      return await finish(outcomeOf('pull_request'), { ...reason, run, model: modelId, committed: changed, commitSha, pullRequest, states });
    }
    const commitSha = await repository.commit(changed, message);
    await repository.push(branch);
    return await finish(outcomeOf('committed'), { ...reason, run, model: modelId, committed: changed, commitSha, states });
  } catch (error) {
    if (error instanceof GitCommandError) return finish('failed', { reasonCode: error.code, run, model: modelId });
    throw error;
  }
}
