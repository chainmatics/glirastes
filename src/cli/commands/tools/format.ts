import type { SchemaQuality } from '../../../codegen/tools/artifact.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolTombstonesFileSchema } from '../../../codegen/tools/files.js';
import { nextActionFor } from '../../../codegen/tools/findings.js';
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { buildResolveWorklist, describeGaps } from '../../../codegen/tools/worklist.js';
import type { ToolsWatchFactory } from './watch.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';

export interface ToolsIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  error(line: string): void;
  runPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult>;
  /** `tools refresh --watch`: file watching and the stop signal (tests inject both). */
  watch?: ToolsWatchFactory;
  signal?: AbortSignal;
}

export interface ToolStatusEntry {
  toolId: string;
  name: string;
  route: string;
  enabled: boolean;
  needsAttention: boolean;
  riskClass: ToolRiskClass;
  confirmation: boolean;
  /** Where the code report says the confirmation comes from; null when it does not say. */
  confirmationOrigin: 'code-default' | 'local-policy' | null;
  /** D16: asks first, and a connected Platform's owner or admin may switch that off. */
  platformMayRelax: boolean;
  contractSource: ContractSource | null;
  descriptionQuality: DescriptionOrigin;
  schemaQuality: SchemaQuality;
}

interface ToolLabel {
  name: string;
  route: string;
  detail: string;
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function labels(result: ToolsPipelineResult): Map<string, ToolLabel> {
  const map = new Map<string, ToolLabel>();
  const artifact = AppSetupArtifactSchema.safeParse(parseJson(result.outputs[TOOLS_PATHS.setupArtifact]));
  if (artifact.success) {
    for (const tool of artifact.data.tools) {
      map.set(tool.toolId, {
        name: tool.name,
        route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
        detail: `${tool.riskClass}${tool.requiresApproval ? ', confirmation' : ''}${tool.enabled ? '' : ', disabled'}`,
      });
    }
  }
  const tombstones = ToolTombstonesFileSchema.safeParse(parseJson(result.outputs[TOOLS_PATHS.tombstones]));
  if (tombstones.success) {
    for (const tombstone of tombstones.data.tombstones) {
      if (!map.has(tombstone.toolId)) {
        map.set(tombstone.toolId, { name: tombstone.definitionId, route: tombstone.stableKey, detail: 'removed' });
      }
    }
  }
  return map;
}

export function formatToolsJson(result: ToolsPipelineResult): string {
  return JSON.stringify({
    schemaVersion: 1,
    mode: result.mode,
    wrote: result.wrote,
    changes: result.changes,
    driftPaths: result.driftPaths,
    findings: result.findings,
    excluded: result.excluded,
  });
}

function outcomeLine(result: ToolsPipelineResult): string {
  if (result.findings.some((finding) => finding.severity === 'error')) {
    return result.mode === 'write'
      ? 'Nothing was written. Fix the errors above and run glirastes tools refresh again.'
      : 'Check failed: tool outputs do not match the code.';
  }
  if (result.mode === 'write') {
    return result.wrote
      ? `Updated ${result.driftPaths.length} file(s). Commit them together with your code.`
      : 'Tool outputs are up to date.';
  }
  return result.mode === 'integrity' ? 'Tool outputs verified (integrity).' : 'Tool outputs match the code.';
}

export function formatToolsHuman(result: ToolsPipelineResult): string {
  const lookup = labels(result);
  const describe = (toolId: string) => {
    const label = lookup.get(toolId);
    return label ? `${label.name}  ${label.route}  [${label.detail}]` : toolId;
  };
  const lines: string[] = [
    `Glirastes tools (${result.mode}): ${result.changes.added.length} added, `
      + `${result.changes.changed.length} changed, ${result.changes.removed.length} removed`,
  ];
  const section = (title: string, items: ReadonlyArray<string>, next?: string) => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length})`, ...items.map((item) => `  ${item}`));
    if (next) lines.push(`  Next: ${next}`);
  };
  const detailed = (title: string, marker: string, findings: ReadonlyArray<ToolFinding>) => {
    if (findings.length === 0) return;
    lines.push('', `${title} (${findings.length})`);
    for (const finding of findings) {
      lines.push(`  ${marker} ${finding.subjectRef}  ${finding.code}: ${finding.message}`, `    Next: ${finding.nextAction}`);
    }
  };
  section('Added', result.changes.added.map((toolId) => `+ ${describe(toolId)}`),
    'Review .glirastes/setup-artifact.json in your diff and commit it together with the code.');
  section('Changed', result.changes.changed.map((toolId) => `~ ${describe(toolId)}`),
    'Review the tool diff and commit it together with the code.');
  section('Risk raised', result.findings
    .filter((finding) => finding.code === 'risk-raised')
    .map((finding) => `^ ${finding.subjectRef}: ${finding.message}`), nextActionFor('risk-raised'));
  section('Removed', result.changes.removed.map((toolId) => `- ${describe(toolId)}`),
    'Nothing to do: the tool is tombstoned and stops working after the next build or restart.');
  detailed('Needs attention', '!', result.findings.filter((finding) => finding.severity === 'needs_attention'));
  section('Excluded', result.excluded.map((entry) => `. ${entry.stableKey}  ${entry.reason} (${entry.origin})`),
    'Excluded routes are never tools; remove a matching exclude entry from .glirastes/tool-policy.json to include a policy exclusion.');
  detailed('Errors', 'x', result.findings.filter((finding) => finding.severity === 'error'));
  const warnings = result.findings.filter((finding) => finding.severity === 'warning' && finding.code !== 'risk-raised');
  if (warnings.length > 0) {
    lines.push('', `Warnings (${warnings.length})`);
    for (const finding of warnings) lines.push(`  - ${finding.subjectRef}  ${finding.code}: ${finding.message}`);
  }
  lines.push('', outcomeLine(result));
  return lines.join('\n');
}

/** The confirmation label `tools status` and `tools policy show` share (D16). */
export function confirmationLabel(
  entry: Pick<ToolStatusEntry, 'confirmation' | 'confirmationOrigin' | 'platformMayRelax' | 'riskClass'>,
): string {
  if (!entry.confirmation) return 'runs directly';
  if (entry.platformMayRelax) return 'asks first, Platform may relax';
  if (entry.confirmationOrigin === 'local-policy' && riskTier(entry.riskClass) <= 2) {
    return 'asks first, locked in tool-policy.json';
  }
  return 'asks first';
}

function tools(count: number, verb: [string, string]): string {
  return `${count} tool${count === 1 ? '' : 's'} ${count === 1 ? verb[0] : verb[1]}`;
}

/**
 * The closing sentences of a refresh (spec 4.6): what the developer's own
 * coding agent can still do, with the command that prints its work list.
 */
export function agentWorkNotes(result: ToolsPipelineResult): string[] {
  const views = result.tools ?? [];
  const attention = new Set(buildResolveWorklist(result).items
    .filter((item) => item.owner === 'agent' && item.toolId !== null)
    .map((item) => item.stableKey)).size;
  const describe = views.filter((tool) => tool.contract !== null && describeGaps(tool).length > 0).length;
  const notes: string[] = [];
  if (attention > 0) {
    notes.push(`${tools(attention, ['needs', 'need'])} attention – your coding agent can resolve this with \`glirastes tools resolve --print\`.`);
  }
  if (describe > 0) {
    notes.push(`${tools(describe, ['needs', 'need'])} a better description – your coding agent can do this with \`glirastes tools describe --print\`.`);
  }
  return notes;
}

export function formatToolStatus(entries: ReadonlyArray<ToolStatusEntry>): string {
  const active = entries.filter((entry) => entry.enabled).length;
  const attention = entries.filter((entry) => entry.needsAttention).length;
  const lines = [
    `What can my chat do? ${active} active tool${active === 1 ? '' : 's'}, ${attention} need${attention === 1 ? 's' : ''} attention.`,
  ];
  for (const entry of entries) {
    const state = entry.needsAttention ? ', disabled: needs attention' : entry.enabled ? '' : ', disabled';
    lines.push(
      `  ${entry.enabled ? '+' : '!'} ${entry.name}  ${entry.route}  ${entry.riskClass}, `
        + `${confirmationLabel(entry)}${state}`,
      `      contract: ${entry.contractSource ?? 'none'}, description: ${entry.descriptionQuality}, schema: ${entry.schemaQuality}`,
    );
  }
  if (entries.some((entry) => entry.platformMayRelax)) {
    lines.push(
      '',
      'A Platform owner or admin can switch off a confirmation marked "Platform may relax" for a connected app.',
      'To keep one, run glirastes tools policy confirm <tool>; it writes "requiresApproval": true to .glirastes/tool-policy.json.',
    );
  }
  return lines.join('\n');
}
