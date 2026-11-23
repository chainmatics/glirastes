import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import {
  contractViolations,
  mergeResolutions,
  mergeSemantics,
  openSemanticsFields,
  rejectedKeys,
  withoutTools,
  writePolicy,
  type WritePolicy,
} from '../../../agent/enrich-guard.js';
import { environmentBranches, promotionSource } from '../../../agent/environments.js';
import {
  BOT_MARKER,
  execFileRunner,
  GitCommandError,
  GitRepository,
  isBotCommit,
  loopGuard,
  pathViolations,
  type Exec,
} from '../../../agent/git.js';
import { createJobModel, ModelAccessError, selectJobModel, type CreateOpenAI } from '../../../agent/openrouter.js';
import {
  isCiKey,
  PlatformToolJobs,
  TOOL_JOB_ITEM_LIMIT,
  ToolJobRequestError,
  type ToolJobItem,
  type ToolJobLedger,
  type ToolJobOutcome,
} from '../../../agent/platform-jobs.js';
import { runSkillJob, type JobPlan, type JobSkill, type RefreshSummary, type SkillJobResult } from '../../../agent/runner.js';
import { Workspace } from '../../../agent/workspace.js';
import { ENRICH_TIMEOUT_MINUTES } from '../ci-workflow.js';
import { loadToolsConfig, TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { evaluateRouting } from '../../../codegen/tools/routing-eval.js';
import { requiredLanguages, SEMANTICS_FIELDS, type SemanticsField } from '../../../codegen/tools/semantics.js';
import { ToolsPipelineFailure, type ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import {
  buildDescribeWorklist,
  buildResolveWorklist,
  type DescribeWorkItem,
  type ResolveWorkItem,
} from '../../../codegen/tools/worklist.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { findPackageSkillsDir } from '../install-skills.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

export const ENRICH_ARGS = {
  flags: ['--managed', '--first-run', '--json'],
  values: ['--root', '--base', '--head', '--environments'],
} as const;

/** The skills the local coding agent uses; the managed job runs exactly these (spec 4.6). */
export const MANAGED_JOB_SKILLS = ['maintaining-glirastes-tools', 'describing-glirastes-tools'] as const;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DISCOVERY_DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
/** Tools of one module the model describes in one task. */
export const MAX_TASK_TOOLS = 8;
/** A tool none of whose gaps closed gets one more task, never a third. */
const MAX_ITEM_ATTEMPTS = 2;
/** A work list this long is an app's backlog: the Platform grants the first-run budget. */
const FIRST_RUN_ITEMS = 20;
/** Left of the CI job's timeout for the last refresh, the commit, the push and the ledger. */
const CI_TAIL_MINUTES = 10;

/**
 * When the model work ends: before the CI job is cancelled (which would lose
 * the uncommitted work and the ledger) and before the job key expires.
 */
export function jobDeadline(startedMs: number, expiresAt: string): Date {
  return new Date(Math.min(new Date(expiresAt).getTime(), startedMs + (ENRICH_TIMEOUT_MINUTES - CI_TAIL_MINUTES) * 60_000));
}

export interface EnrichDependencies {
  exec?: Exec;
  fetchImpl?: typeof fetch;
  /** Loads `@ai-sdk/openai` on demand; only `tools enrich --managed` ever does. */
  loadOpenAI?: () => Promise<CreateOpenAI>;
  now?: () => Date;
}

interface EnrichSummary {
  schemaVersion: 1;
  /** `partial`: the job closed some items and left others untouched (`items.unchanged`). */
  status: 'skipped' | 'finished' | 'partial' | 'failed';
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

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** The message of an unexpected error for the CI log, without anything that looks like a key. */
function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gl_[A-Za-z0-9_]{8,}|Bearer\s+\S+)/g, '[redacted]').slice(0, 500);
}

async function readSkills(): Promise<JobSkill[]> {
  const dir = findPackageSkillsDir();
  return Promise.all(MANAGED_JOB_SKILLS.map(async (name) => ({
    name,
    text: await readFile(join(dir, name, 'SKILL.md'), 'utf8'),
  })));
}

/** Only an explicit 401 counts; an OpenRouter outage is left to the model step. */
async function openRouterRejects(apiKey: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL}/key`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

async function currentBranch(exec: Exec, root: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fromCi = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (fromCi) return fromCi;
  const result = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== 'HEAD' ? branch : undefined;
}


/** Gaps that mean a tool's semantics are missing or written for another interface: every run works them. */
const STALE_GAPS: ReadonlySet<string> = new Set([
  'description-templated', 'synonyms-missing', 'examples-missing', 'semantics-stale', 'enrichment-stale',
]);
/** Gaps a typed schema in tool-resolutions.json closes; besides stale tools only a first run works them. */
const SCHEMA_GAPS: ReadonlySet<string> = new Set(['contract-derived', 'output-contract-opaque', 'filter-domain-open', 'enrichment-stale']);

export interface EnrichScope {
  /** Tools whose semantics the job works. */
  semantics: Set<string>;
  /** Tools whose tool-resolutions.json entry the job may write. */
  resolutions: Set<string>;
  conventions: boolean;
}

/**
 * The tools that need work, whatever the branch is compared with: semantics
 * that are missing, stale or rejected, and stage-1 items for the agent's data
 * files. A first run also takes schema gaps of otherwise current tools. A
 * tool whose only gap is routing (or nothing) is never in scope: its current
 * entries stay as they are.
 */
export function enrichScope(
  resolveItems: ReadonlyArray<Pick<ResolveWorkItem, 'stableKey' | 'toolId' | 'owner' | 'code' | 'target'>>,
  describeItems: ReadonlyArray<Pick<DescribeWorkItem, 'stableKey' | 'gaps'>>,
  firstRun: boolean,
): EnrichScope {
  const scope: EnrichScope = { semantics: new Set(), resolutions: new Set(), conventions: false };
  for (const item of describeItems) {
    const stale = item.gaps.some((gap) => STALE_GAPS.has(gap));
    const schema = item.gaps.some((gap) => SCHEMA_GAPS.has(gap));
    if (stale || (firstRun && schema)) scope.semantics.add(item.stableKey);
    if (schema && (stale || firstRun)) scope.resolutions.add(item.stableKey);
  }
  for (const item of resolveItems) {
    if (item.owner !== 'agent' || item.toolId === null || item.target.kind !== 'file') continue;
    if (item.target.file === TOOLS_PATHS.semantics) scope.semantics.add(item.stableKey);
    else if (item.target.file === TOOLS_PATHS.resolutions) {
      scope.resolutions.add(item.stableKey);
      if (item.code === 'auth-evidence-missing') scope.conventions = true;
    }
  }
  return scope;
}

/** A describe item as the model sees it: only the fields and the schema the job may still write. */
export function restrictItem(item: DescribeWorkItem, policy: WritePolicy): DescribeWorkItem {
  const allowed = policy.tools.get(item.stableKey);
  const open = new Set<string>(openSemanticsFields(allowed));
  const expected = Object.fromEntries(Object.entries(item.targets.semantics.expected)
    .filter(([key]) => !(SEMANTICS_FIELDS as ReadonlyArray<string>).includes(key) || open.has(key))
    .map(([key, value]) => {
      const languages = allowed?.languages.get(key as SemanticsField);
      if (!languages || allowed?.fields.has(key as SemanticsField) || !isRecord(value)) return [key, value];
      return [key, Object.fromEntries(Object.entries(value).filter(([language]) => (languages as string[]).includes(language)))];
    }));
  if (isRecord(expected.origin)) {
    expected.origin = Object.fromEntries(Object.entries(expected.origin).filter(([field]) => allowed?.fields.has(field as SemanticsField)));
  }
  const { schema, ...targets } = item.targets;
  return {
    ...item,
    protectedFields: SEMANTICS_FIELDS.filter((field) => !allowed?.fields.has(field)),
    targets: {
      ...targets,
      semantics: { ...item.targets.semantics, expected },
      ...(schema && allowed?.resolution ? { schema } : {}),
    },
  };
}

async function writeOrRemove(path: string, text: string | null): Promise<void> {
  if (text === null) await rm(path, { force: true });
  else await writeFile(path, text);
}

function findingKey(finding: { code: string; subjectRef: string; message: string }): string {
  return `${finding.code}|${finding.subjectRef}|${finding.message}`;
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
  const base = args.values.get('--base') || io.env.GLIRASTES_BASE_BRANCH?.trim() || io.env.GITHUB_BASE_REF?.trim() || 'main';
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? execFileRunner;
  const started = now().getTime();

  // The CI key and the BYOK key come from the CI secrets; the app's own
  // OPENROUTER_API_KEY (its chat) is never read here.
  const ciKey = io.env.GLIRASTES_CI_KEY?.trim();
  const baseUrl = io.env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  if (!ciKey || !baseUrl) return report(io, json, { schemaVersion: 1, status: 'failed', code: 'managed_config_missing' });
  // A secret pasted from the wrong clipboard is named, before any work starts.
  if (!isCiKey(ciKey)) return report(io, json, { schemaVersion: 1, status: 'failed', code: 'ci_key_invalid' });
  const config = loadToolsConfig(root);
  const repository = new GitRepository(root, exec);
  const head = await repository.head();
  // A run the bot's own commit started does nothing, before any refresh or request.
  if (isBotCommit(head)) return report(io, json, { schemaVersion: 1, status: 'skipped', code: 'last_commit_by_bot' });
  const branch = args.values.get('--head') || io.env.GLIRASTES_HEAD_BRANCH?.trim() || await currentBranch(exec, root, io.env);
  if (!branch || !BRANCH.test(branch) || !BRANCH.test(base)) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'branch_unknown' });
  }
  // The generated workflow sets GLIRASTES_FIRST_RUN on its manual start.
  const firstRun = args.flags.has('--first-run') || io.env.GLIRASTES_FIRST_RUN === 'true';

  // A promotion carries what a lower environment accepted; it never changes it.
  if (!firstRun) {
    const chain = await environmentBranches({
      flag: args.values.get('--environments'),
      env: io.env.GLIRASTES_ENVIRONMENT_BRANCHES,
      config: config.enrich.environments,
      remoteBranches: () => repository.remoteBranches(),
    });
    const from = await promotionSource({
      head: branch,
      base,
      environments: chain.branches,
      containedIn: (environment) => repository.containedIn(head.sha, environment),
    });
    if (from !== undefined) {
      io.error(`glirastes tools enrich: promotion from ${from}, nothing to enrich`);
      return report(io, json, { schemaVersion: 1, status: 'skipped', code: 'promotion' });
    }
  }

  // A BYOK key OpenRouter rejects fails here, before the Platform reserves a job.
  const byokKey = io.env.GLIRASTES_TOOLS_OPENROUTER_KEY?.trim();
  if (byokKey && await openRouterRejects(byokKey, deps.fetchImpl ?? fetch)) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'byok_key_invalid' });
  }

  const initial = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  const describeOptions = {
    root,
    locale: config.locale,
    languages: requiredLanguages(config.locale, config.languages),
    writeContracts: config.enrich.writeContracts === true,
  };
  const scope = enrichScope(buildResolveWorklist(initial).items, buildDescribeWorklist(initial, describeOptions).items, firstRun);
  const keys = new Set([...scope.semantics, ...scope.resolutions]);
  const listsOf = (result: ToolsPipelineResult) => {
    const allResolve = buildResolveWorklist(result);
    const allDescribe = buildDescribeWorklist(result, describeOptions);
    const resolveList = { ...allResolve, items: allResolve.items.filter((item) => item.toolId !== null && keys.has(item.stableKey)) };
    const describeItems = allDescribe.items.filter((item) => keys.has(item.stableKey));
    const describeList = {
      ...allDescribe,
      items: describeItems,
      modules: allDescribe.modules
        .map((entry) => ({ module: entry.module, tools: entry.tools.filter((tool) => describeItems.some((item) => item.tool === tool)) }))
        .filter((entry) => entry.tools.length > 0),
    };
    return { result, resolveList, describeList, items: jobItems(resolveList.items, describeList.items) };
  };
  const worklists = async () => listsOf(await io.runPipeline({ root, mode: 'frozen', keepGoing: true }));
  const before = listsOf(initial);
  io.error(`glirastes tools enrich: scope=${firstRun ? 'backlog' : 'stale'} items=${before.items.length}`);
  const skip = loopGuard(head, before.items.length);
  if (skip) return report(io, json, { schemaVersion: 1, status: 'skipped', code: skip });
  // A branch `tools check` already fails would fail after the job too: no model is paid for a commit that cannot pass.
  if (initial.findings.some((finding) => finding.severity === 'error' && finding.code !== 'tool-outputs-drift')) {
    return report(io, json, { schemaVersion: 1, status: 'failed', code: 'check_failing' });
  }

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

  const semanticsPath = join(root, TOOLS_PATHS.semantics);
  const resolutionsPath = join(root, TOOLS_PATHS.resolutions);
  const stored = { semantics: await readText(semanticsPath), resolutions: await readText(resolutionsPath) };
  const initialRejections = new Set(initial.findings.map(findingKey));
  let policy = writePolicy({
    tools: initial.tools ?? [],
    scope: scope.semantics,
    resolutionScope: scope.resolutions,
    semantics: stored.semantics,
    resolutions: stored.resolutions,
    rejected: rejectedKeys(initial.findings, stored.semantics),
    conventions: scope.conventions,
  });

  const jobs = new PlatformToolJobs({ baseUrl, appId: config.appId, ciKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  let grant;
  try {
    grant = await jobs.create({
      schemaVersion: 1,
      discoveryDigest: artifact.discoveryDigest,
      commitSha: head.sha,
      branch,
      firstRun: firstRun || before.items.length > FIRST_RUN_ITEMS,
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
      status: outcome === 'failed' || input.reasonCode === 'no_progress' ? 'failed'
        : input.reasonCode === 'items_remaining' ? 'partial' : 'finished',
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
  /** Puts the agent's data files back as the job found them, so a failed job leaves nothing behind. */
  const restore = async () => {
    await writeOrRemove(semanticsPath, stored.semantics);
    await writeOrRemove(resolutionsPath, stored.resolutions);
  };

  // Any unexpected throw after the grant still reports a ledger, so the job is released.
  const execute = async () => {
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
    let latest = before.result;
    // Tasks run side by side; the generator and the git steps run one at a time.
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(step: () => Promise<T>): Promise<T> => {
      const turn = queue.then(step);
      queue = turn.catch(() => undefined);
      return turn;
    };
    const refresh = (): Promise<RefreshSummary> => inTurn(async () => {
      const result = await io.runPipeline({ root, mode: 'write', keepGoing: true });
      latest = result;
      for (const path of Object.keys(result.outputs)) allowed.files.add(path);
      return {
        findings: result.findings.slice(0, 200).map(({ code, subjectRef, message }) => ({ code, subjectRef, message })),
        changed: result.changes.added.length + result.changes.changed.length + result.changes.removed.length,
      };
    });
    const evaluate = async () => {
      const setup = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.enrich');
      const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.enrich');
      const evaluation = evaluateRouting({ artifact: setup, contracts: contracts.tools });
      return { failed: evaluation.summary.failed, failures: evaluation.tools.filter((tool) => tool.failures.length > 0).slice(0, 50) };
    };

    // The runner asks for one task at a time; each is cut from the state the last refresh left.
    const attempts = new Map<string, { count: number; gaps: ReadonlyArray<string> }>();
    let resolveOffered = false;
    /** Tools a running task holds; nobody else gets them until it is over. */
    const inFlight = new Set<string>();
    const plan: JobPlan = {
      finished: (task) => {
        for (const key of task.keys) inFlight.delete(key);
      },
      next: async () => {
        const lists = listsOf(latest);
        if (!resolveOffered) {
          resolveOffered = true;
          const agentItems = lists.resolveList.items.filter((item) => item.owner === 'agent');
          if (agentItems.length > 0) {
            return {
              id: 'resolve',
              worklists: { resolve: { ...lists.resolveList, items: agentItems } },
              open: agentItems.length,
              keys: agentItems.map((item) => item.stableKey),
              exclusive: true,
            };
          }
        }
        const candidates = lists.describeList.items.filter((item) => {
          if (inFlight.has(item.stableKey)) return false;
          const tried = attempts.get(item.stableKey);
          if (!tried) return true;
          // Again only when the first task closed none of its gaps.
          return tried.count < MAX_ITEM_ATTEMPTS && tried.gaps.every((gap) => (item.gaps as string[]).includes(gap));
        });
        const first = candidates[0];
        if (!first) return null;
        const chunk = candidates.filter((item) => item.module === first.module).slice(0, MAX_TASK_TOOLS);
        for (const item of chunk) {
          inFlight.add(item.stableKey);
          const tried = attempts.get(item.stableKey);
          attempts.set(item.stableKey, { count: (tried?.count ?? 0) + 1, gaps: tried?.gaps ?? [...item.gaps] });
        }
        return {
          id: `describe:${first.module}`,
          worklists: {
            describe: {
              ...lists.describeList,
              modules: [{ module: first.module, tools: chunk.map((item) => item.tool) }],
              items: chunk.map((item) => restrictItem(item, policy)),
            },
          },
          open: chunk.length,
          keys: chunk.map((item) => item.stableKey),
        };
      },
    };
    const run = await runSkillJob({
      model,
      modelId,
      skills: await readSkills(),
      plan,
      onTask: (task) => {
        io.error(`glirastes tools enrich: task ${task.id} items=${task.open} steps=${task.steps} finish=${task.finishReason}${task.repaired ? ' repaired' : ''}`);
      },
      workspace,
      tools: { refresh, evaluate },
      budgetUsd: grant.budgetUsd,
      deadline: jobDeadline(started, grant.expiresAt),
      now,
    });
    await queue;
    const ranModel = MODEL_ID.test(run.servedModel) ? run.servedModel : modelId;

    for (const path of workspace.written) allowed.files.add(path);
    if (pathViolations(await repository.changedPaths(), allowed).length > 0) {
      return finish('failed', { reasonCode: 'path_violation', run, model: modelId });
    }

    // The model's files are proposals: only what the policy allows is kept, entries the
    // generator rejects are taken back, and the result must pass glirastes tools check.
    const proposed = { semantics: await readText(semanticsPath), resolutions: await readText(resolutionsPath) };
    const takenBack = new Set<string>();
    let refreshed: ToolsPipelineResult | undefined;
    for (let round = 0; round < 3; round += 1) {
      const semantics = mergeSemantics(stored.semantics, proposed.semantics, policy, ranModel);
      const resolutions = mergeResolutions(stored.resolutions, proposed.resolutions, policy, ranModel);
      await writeOrRemove(semanticsPath, semantics.text);
      await writeOrRemove(resolutionsPath, resolutions.text);
      refreshed = await io.runPipeline({ root, mode: 'write', keepGoing: true });
      const written = new Set([...semantics.changed, ...resolutions.changed]);
      const rejected = [...rejectedKeys(refreshed.findings.filter((finding) => !initialRejections.has(findingKey(finding))), semantics.text)]
        .filter((key) => written.has(key));
      if (rejected.length === 0) break;
      for (const key of rejected) takenBack.add(key);
      io.error(`glirastes tools enrich: ${rejected.length} rejected entr${rejected.length === 1 ? 'y' : 'ies'} taken back`);
      policy = withoutTools(policy, new Set(rejected));
      refreshed = undefined;
    }
    for (const path of Object.keys(refreshed?.outputs ?? {})) allowed.files.add(path);
    const verified = await (async (): Promise<string | undefined> => {
      if (!refreshed) return 'rejected_entries';
      let check: ToolsPipelineResult;
      try {
        check = await io.runPipeline({ root, mode: 'frozen' });
      } catch (error) {
        if (error instanceof ToolsPipelineFailure) {
          const codes = [...new Set(error.result.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code))];
          io.error(`glirastes tools enrich: tools check would fail (${codes.join(', ')})`);
          return 'check_failed';
        }
        throw error;
      }
      const newRejections = check.findings.filter((finding) => (finding.code === 'resolution-rejected' || finding.code === 'tool-semantics-invalid')
        && !initialRejections.has(findingKey(finding)));
      if (newRejections.length > 0) return 'rejected_entries';
      const violations = contractViolations(before.result.outputs[TOOLS_PATHS.contracts], check.outputs[TOOLS_PATHS.contracts], keys);
      if (violations.length > 0) {
        io.error(`glirastes tools enrich: tool-contracts.json would change outside the scope: ${violations.slice(0, 10).join('; ')}`);
        return 'contracts_out_of_scope';
      }
      return undefined;
    })();
    if (verified) {
      await restore();
      await io.runPipeline({ root, mode: 'write', keepGoing: true });
      return finish('failed', { reasonCode: verified, run, model: modelId });
    }

    const changed = await repository.changedPaths();
    if (pathViolations(changed, allowed).length > 0) {
      return finish('failed', { reasonCode: 'path_violation', run, model: modelId });
    }
    const after = await worklists();
    const open = new Map(after.items.map((item) => [item.stableKey, new Set(item.gaps)]));
    const states: ToolJobLedger['items'] = items.map((item) => {
      if (takenBack.has(item.stableKey)) return { stableKey: item.stableKey, state: 'failed', reasonCode: 'resolution-rejected' };
      const remaining = open.get(item.stableKey) ?? new Set<string>();
      const closed = item.gaps.filter((gap) => !remaining.has(gap));
      if (closed.length === 0) return { stableKey: item.stableKey, state: 'unchanged' };
      const resolutionCodes = new Set(before.resolveList.items.map((entry) => entry.code));
      const state = closed.some((gap) => resolutionCodes.has(gap)) ? 'resolved' : 'described';
      // Some gaps closed, others still open (e.g. a schema the job did not write).
      return closed.length < item.gaps.length
        ? { stableKey: item.stableKey, state, reasonCode: 'gaps-remaining' }
        : { stableKey: item.stableKey, state };
    });
    const closed = states.filter((item) => item.state === 'resolved' || item.state === 'described').length;
    const untouched = states.filter((item) => item.state === 'unchanged').length;
    // A run that failed after closing items keeps them; one that closed nothing is a failure, whatever the model said.
    if (run.outcome === 'failed' && closed === 0) {
      return finish('failed', { reasonCode: run.reasonCode ?? 'model_error', run, model: modelId });
    }
    const reasonCode = run.reasonCode ?? (closed === 0 ? 'no_progress' : untouched > 0 ? 'items_remaining' : undefined);
    const reason = reasonCode ? { reasonCode } : {};
    const outcomeOf = (committed: ToolJobOutcome): ToolJobOutcome => (
      run.outcome === 'completed' || run.outcome === 'failed' ? committed : run.outcome
    );
    if (untouched > 0) io.error(`glirastes tools enrich: ${untouched} of ${states.length} items are still open`);
    // Nothing closed: refreshed outputs alone are no reason to commit or open a pull request.
    if (changed.length === 0 || closed === 0) {
      return finish(closed === 0 ? 'failed' : outcomeOf('no_change'), { ...reason, run, model: modelId, states });
    }
    // One commit per job, made once the outputs pass the check: a push starts the checks once.
    const message = `chore(glirastes): describe tools ${BOT_MARKER}\n\nGlirastes-Job: ${grant.jobId}`;
    try {
      let botBranch: string | undefined;
      if (branch === base) {
        botBranch = `glirastes/tools-${head.sha.slice(0, 12)}`;
        await repository.switchToNewBranch(botBranch);
      }
      const commitSha = await repository.commit(changed, message);
      await repository.push(botBranch ?? branch);
      const done = { ...reason, run, model: modelId, committed: changed, commitSha, states };
      if (botBranch) {
        const pullRequest = await repository.openPullRequest({
          base,
          head: botBranch,
          title: `chore(glirastes): describe tools ${BOT_MARKER}`,
          body: `Glirastes job ${grant.jobId} wrote tool descriptions, schemas and their generated outputs. Review them, then run glirastes tools verify.`,
        });
        return await finish(outcomeOf('pull_request'), { ...done, pullRequest });
      }
      return await finish(outcomeOf('committed'), done);
    } catch (error) {
      if (error instanceof GitCommandError) return finish('failed', { reasonCode: error.code, run, model: modelId });
      throw error;
    }
  };
  try {
    return await execute();
  } catch (error) {
    io.error(`glirastes tools enrich: runner_error: ${causeOf(error)}`);
    return finish('failed', { reasonCode: 'runner_error' });
  }
}
