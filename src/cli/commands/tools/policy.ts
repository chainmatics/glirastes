import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, compareCodeUnits } from '../../../codegen/tools/canonical.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolContractsFileSchema } from '../../../codegen/tools/files.js';
import { AppSetupArtifactSchema, ToolRiskClassSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { parseExcludePattern } from '../../../contracts/tool-exclude-pattern.js';
import {
  platformMayRelaxConfirmation,
  resolveToolPolicy,
  riskTier,
  ToolPolicyFileSchema,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
  type ToolPolicyFile,
} from '../../../contracts/tool-policy.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import { writeArtifactSetAtomically } from '../atomic-artifact-write.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from './args.js';
import { confirmationLabel, type ToolsIo } from './format.js';
import { readToolOutput } from './status.js';

/**
 * `glirastes tools policy` (spec 4.2, 4.5): the developer's local overrides
 * in `.glirastes/tool-policy.json`. Every edit is checked by the same
 * `resolveToolPolicy` the generator uses before it is written, so the CLI
 * never writes a policy that refresh would refuse. Agents never run it.
 */
export const POLICY_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  show: { flags: ['--json'], values: ['--root'], positionals: 1 },
  disable: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  enable: { flags: [], values: ['--root'], positionals: 1 },
  confirm: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  relax: { flags: ['--yes'], values: ['--root', '--reason'], positionals: 1 },
  raise: { flags: [], values: ['--root', '--reason'], positionals: 2 },
  roles: { flags: [], values: ['--root', '--reason'], positionals: 2 },
  describe: { flags: [], values: ['--root'], positionals: 2 },
  exclude: { flags: [], values: ['--root', '--reason'], positionals: 1 },
  include: { flags: [], values: ['--root'], positionals: 1 },
  accept: { flags: [], values: ['--root'], positionals: 1 },
  reset: { flags: [], values: ['--root'], positionals: 1 },
};

export const POLICY_USAGE = [
  'Usage: glirastes tools policy show [<tool>] [--json]',
  '       glirastes tools policy disable|enable|confirm <tool> [--reason <text>]',
  '       glirastes tools policy relax <tool> --yes [--reason <text>]   (write tools only; delete, financial and external always confirm)',
  '       glirastes tools policy raise <tool> <safe-read|read-sensitive|write|delete|financial|external> [--reason <text>]',
  '       glirastes tools policy roles <tool> <role,role|-> [--reason <text>]',
  '       glirastes tools policy describe <tool> <text|->',
  '       glirastes tools policy exclude "<METHOD|PAGE|*> /path/**" --reason <text>',
  '       glirastes tools policy include "<pattern>"',
  '       glirastes tools policy accept <tool>    (adopt a lower risk the code now implies)',
  '       glirastes tools policy reset <tool>     (remove every local entry of the tool)',
].join('\n');

interface ToolRef {
  toolId: string;
  stableKey: string;
  name: string;
  route: string;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  confirmationOrigin: 'code-default' | 'local-policy' | null;
  platformMayRelax: boolean;
  enabled: boolean;
  needsAttention: boolean;
  defaults: ToolPolicyDefaults;
}

async function readPolicy(root: string): Promise<ToolPolicyFile> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, TOOLS_PATHS.policy), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ToolPolicyFileSchema.parse({ schemaVersion: 1 });
    }
    throw error;
  }
  let parsed: ReturnType<typeof ToolPolicyFileSchema.safeParse> | undefined;
  try {
    parsed = ToolPolicyFileSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-POLICY-001',
      operation: 'tools.policy',
      message: 'tool-policy.json is not valid; fix it by hand before changing it with the CLI.',
      remediation: 'repair-tool-policy-file',
      path: TOOLS_PATHS.policy,
    });
  }
  return parsed.data;
}

/** Stable keys and entries sorted, exclusions in the order they were added. */
function renderPolicy(file: ToolPolicyFile): string {
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  return canonicalJson({
    schemaVersion: 1,
    tools: sorted(file.tools),
    exclude: file.exclude,
    acceptedRisk: sorted(file.acceptedRisk),
  });
}

async function writePolicy(root: string, file: ToolPolicyFile): Promise<void> {
  const checked = ToolPolicyFileSchema.safeParse(file);
  if (!checked.success) {
    const field = checked.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new ToolsUsageError(`The change would make tool-policy.json invalid${field ? ` at ${field}` : ''}; nothing was written.`);
  }
  await writeArtifactSetAtomically([{ path: resolve(root, TOOLS_PATHS.policy), content: renderPolicy(checked.data) }]);
}

async function readTools(root: string): Promise<ToolRef[]> {
  const artifact = await readToolOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema, 'tools.policy');
  const contracts = await readToolOutput(root, TOOLS_PATHS.contracts, ToolContractsFileSchema, 'tools.policy');
  const byId = new Map(contracts.tools.map((entry) => [entry.toolId, entry] as const));
  return artifact.tools.flatMap((tool) => {
    const entry = byId.get(tool.toolId);
    if (!entry) return [];
    const confirmationOrigin = tool.provenance?.policyOrigin?.requiresApproval ?? null;
    return [{
      toolId: tool.toolId,
      stableKey: entry.stableKey,
      name: tool.name,
      route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
      riskClass: tool.riskClass,
      requiresApproval: tool.requiresApproval,
      confirmationOrigin,
      platformMayRelax: tool.requiresApproval
        && platformMayRelaxConfirmation(tool.riskClass, confirmationOrigin ?? undefined),
      enabled: tool.enabled,
      needsAttention: tool.operationGroup === 'needs_attention',
      defaults: entry.defaults,
    }];
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

function findTool(tools: ReadonlyArray<ToolRef>, name: string | undefined): ToolRef {
  if (!name) throw new ToolsUsageError('Name the tool as glirastes tools status prints it.');
  const tool = tools.find((candidate) => candidate.name === name || candidate.stableKey === name);
  if (!tool) throw new ToolsUsageError(`Unknown tool ${name}; glirastes tools status lists the names.`);
  return tool;
}

/** Refuses an entry the generator would refuse, before anything is written. */
function assertResolvable(tool: ToolRef, entry: ToolPolicyEntry, file: ToolPolicyFile): void {
  const accepted = file.acceptedRisk[tool.stableKey];
  const resolved = resolveToolPolicy({
    toolId: tool.toolId,
    defaults: tool.defaults,
    codeEnabled: !tool.needsAttention,
    local: entry,
    ...(accepted ? { acceptedRisk: accepted } : {}),
    previousEffectiveRiskClass: tool.riskClass,
  });
  const error = resolved.errors[0];
  if (error) {
    throw new ToolsUsageError(error.reason === 'tier-3-always-requires-approval'
      ? `${tool.name} is ${tool.riskClass}: delete, financial and external tools always ask first.`
      : `tool-policy.json would be refused (${error.code} ${error.field}: ${error.reason}); nothing was written.`);
  }
}

function withReason(entry: ToolPolicyEntry, reason: string | undefined): ToolPolicyEntry {
  return reason === undefined ? entry : { ...entry, reason };
}

function compact(entry: ToolPolicyEntry): ToolPolicyEntry | undefined {
  const kept = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as ToolPolicyEntry;
  const meaningful = Object.keys(kept).filter((key) => key !== 'reason');
  return meaningful.length > 0 ? kept : undefined;
}

function formatShow(tools: ReadonlyArray<ToolRef>, file: ToolPolicyFile): string {
  const lines = ['Tool policy (effective after the last refresh; local entries from .glirastes/tool-policy.json):'];
  for (const tool of tools) {
    const local = file.tools[tool.stableKey];
    const state = tool.needsAttention ? 'needs attention' : tool.enabled ? 'active' : 'disabled';
    const confirmation = confirmationLabel({ ...tool, confirmation: tool.requiresApproval });
    lines.push(`  ${tool.name}  ${tool.route}  ${tool.riskClass}, ${confirmation}, ${state}`
      + `  (code: ${tool.defaults.riskClass}${tool.defaults.requiresApproval ? ', asks first' : ''})`);
    if (local) lines.push(`      local: ${JSON.stringify(local)}`);
    const accepted = file.acceptedRisk[tool.stableKey];
    if (accepted) lines.push(`      accepted risk: ${accepted.riskClass}`);
  }
  for (const exclusion of file.exclude) lines.push(`  excluded: ${exclusion.match}  (${exclusion.reason})`);
  return lines.join('\n');
}

export async function runToolsPolicy(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const [subcommand, ...rest] = argv;
  const spec = subcommand !== undefined && Object.hasOwn(POLICY_SUBCOMMANDS, subcommand) ? POLICY_SUBCOMMANDS[subcommand] : undefined;
  if (!spec || !subcommand) throw new ToolsUsageError('Choose a tools policy subcommand.');
  const args = parseToolArgs(rest, spec);
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const reason = args.values.get('--reason');
  const [first, second] = args.positionals;
  const file = await readPolicy(root);
  const done = async (next: ToolPolicyFile, message: string): Promise<number> => {
    await writePolicy(root, next);
    io.log(`Updated ${TOOLS_PATHS.policy}: ${message}. Run glirastes tools refresh to apply it.`);
    return 0;
  };

  if (subcommand === 'exclude' || subcommand === 'include') {
    if (!first || !parseExcludePattern(first)) {
      throw new ToolsUsageError('Write the pattern as "<METHOD|PAGE|*> /path/**", e.g. "POST /api/internal/**".');
    }
    if (subcommand === 'exclude') {
      if (!reason) throw new ToolsUsageError('Say why with --reason; the reason is part of the reviewed policy.');
      if (file.exclude.some((entry) => entry.match === first)) throw new ToolsUsageError(`${first} is already excluded.`);
      return done({ ...file, exclude: [...file.exclude, { match: first, reason }] }, `${first} is excluded`);
    }
    if (!file.exclude.some((entry) => entry.match === first)) {
      throw new ToolsUsageError(`No exclude entry matches ${first} exactly; glirastes tools policy show lists them.`);
    }
    return done({ ...file, exclude: file.exclude.filter((entry) => entry.match !== first) }, `${first} is included again`);
  }

  if (subcommand === 'reset' && first && (Object.hasOwn(file.tools, first) || Object.hasOwn(file.acceptedRisk, first))) {
    // Orphaned keys have no tool any more; reset still removes them.
    const { [first]: _tool, ...tools } = file.tools;
    const { [first]: _risk, ...acceptedRisk } = file.acceptedRisk;
    return done({ ...file, tools, acceptedRisk }, `every local entry of ${first} is removed`);
  }

  const tools = await readTools(root);
  if (subcommand === 'show') {
    const selected = first ? [findTool(tools, first)] : tools;
    if (args.flags.has('--json')) {
      io.log(JSON.stringify({
        schemaVersion: 1,
        tools: selected.map((tool) => ({
          name: tool.name,
          stableKey: tool.stableKey,
          route: tool.route,
          effective: {
            riskClass: tool.riskClass,
            requiresApproval: tool.requiresApproval,
            confirmationOrigin: tool.confirmationOrigin,
            platformMayRelax: tool.platformMayRelax,
            enabled: tool.enabled,
          },
          code: { riskClass: tool.defaults.riskClass, requiresApproval: tool.defaults.requiresApproval },
          local: file.tools[tool.stableKey] ?? null,
          acceptedRisk: file.acceptedRisk[tool.stableKey] ?? null,
        })),
        exclude: file.exclude,
      }));
    } else {
      io.log(formatShow(selected, file));
    }
    return 0;
  }

  const tool = findTool(tools, first);
  const current: ToolPolicyEntry = file.tools[tool.stableKey] ?? {};
  const write = async (next: ToolPolicyEntry | undefined, message: string): Promise<number> => {
    const entry = next ? compact(next) : undefined;
    if (entry) assertResolvable(tool, entry, file);
    const { [tool.stableKey]: _previous, ...others } = file.tools;
    return done({ ...file, tools: entry ? { ...others, [tool.stableKey]: entry } : others }, message);
  };

  switch (subcommand) {
    case 'disable':
      return write(withReason({ ...current, enabled: false }, reason), `${tool.name} is disabled`);
    case 'enable': {
      if (current.enabled !== false) {
        throw new ToolsUsageError(`${tool.name} has no local disable; enable only removes one, the code decides whether a tool can run.`);
      }
      return write({ ...current, enabled: undefined }, `${tool.name} is no longer disabled locally`);
    }
    case 'confirm':
      // An explicit `true` is a local lock (D16): the report names it
      // local-policy, so a connected Platform never relaxes it.
      return write(withReason({ ...current, requiresApproval: true, pin: undefined }, reason), riskTier(tool.riskClass) <= 2
        ? `${tool.name} asks before it runs, and a connected Platform can no longer switch that off`
          + ` (glirastes tools policy reset ${tool.name} lifts the lock)`
        : `${tool.name} asks before it runs`);
    case 'relax': {
      if (!args.flags.has('--yes')) {
        throw new ToolsUsageError(`Relaxing lets ${tool.name} run without asking; confirm the review with --yes.`);
      }
      if (riskTier(tool.riskClass) >= 3) {
        throw new ToolsUsageError(`${tool.name} is ${tool.riskClass}: delete, financial and external tools always ask first.`);
      }
      if (!tool.requiresApproval) throw new ToolsUsageError(`${tool.name} already runs without asking.`);
      return write(withReason({
        ...current,
        requiresApproval: false,
        pin: { toolId: tool.toolId, atRiskClass: tool.riskClass },
      }, reason), `${tool.name} runs without asking while it stays ${tool.riskClass} (pinned)`);
    }
    case 'raise': {
      const parsed = ToolRiskClassSchema.exclude(['unknown']).safeParse(second);
      if (!parsed.success) throw new ToolsUsageError('Name a risk class: safe-read, read-sensitive, write, delete, financial or external.');
      if (riskTier(parsed.data) <= riskTier(tool.riskClass)) {
        throw new ToolsUsageError(`${tool.name} is already ${tool.riskClass}; the policy can only raise the risk. A lower code risk is adopted with glirastes tools policy accept.`);
      }
      return write(withReason({ ...current, riskClass: parsed.data }, reason), `${tool.name} is ${parsed.data}`);
    }
    case 'roles': {
      if (!second) throw new ToolsUsageError('Name the roles, comma-separated, or - to remove the restriction.');
      const roles = second === '-' ? [] : [...new Set(second.split(',').map((role) => role.trim()).filter(Boolean))].sort(compareCodeUnits);
      if (second !== '-' && roles.length === 0) throw new ToolsUsageError('Name at least one role, or - to remove the restriction.');
      return write(withReason({ ...current, allowedRoles: roles.length > 0 ? roles : undefined }, reason),
        roles.length > 0 ? `${tool.name} is limited to ${roles.join(', ')}` : `${tool.name} has no local role limit`);
    }
    case 'describe': {
      if (!second) throw new ToolsUsageError('Give the description, or - to remove the local one.');
      return write({ ...current, description: second === '-' ? undefined : second },
        second === '-' ? `${tool.name} uses the description from the code` : `${tool.name} has a local description`);
    }
    case 'accept': {
      const accepted = file.acceptedRisk[tool.stableKey];
      const resolved = resolveToolPolicy({
        toolId: tool.toolId,
        defaults: tool.defaults,
        codeEnabled: !tool.needsAttention,
        ...(file.tools[tool.stableKey] ? { local: file.tools[tool.stableKey] } : {}),
        ...(accepted ? { acceptedRisk: accepted } : {}),
        previousEffectiveRiskClass: tool.riskClass,
      });
      const lower = resolved.warnings.find((warning) => warning.code === 'risk-lower-available');
      if (!lower?.riskClass) {
        throw new ToolsUsageError(`${tool.name} has no lower risk to accept. Run glirastes tools refresh after the code change first.`);
      }
      return done({
        ...file,
        acceptedRisk: { ...file.acceptedRisk, [tool.stableKey]: { riskClass: lower.riskClass, toolId: tool.toolId } },
      }, `${tool.name} may drop from ${tool.riskClass} to ${lower.riskClass}`);
    }
    case 'reset': {
      if (!Object.hasOwn(file.tools, tool.stableKey) && !Object.hasOwn(file.acceptedRisk, tool.stableKey)) {
        throw new ToolsUsageError(`${tool.name} has no local entry to reset.`);
      }
      const { [tool.stableKey]: _tool, ...others } = file.tools;
      const { [tool.stableKey]: _risk, ...acceptedRisk } = file.acceptedRisk;
      return done({ ...file, tools: others, acceptedRisk }, `every local entry of ${tool.name} is removed`);
    }
    default:
      throw new ToolsUsageError('Choose a tools policy subcommand.');
  }
}
