import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { ToolReportFileSchema } from '../../../codegen/tools/artifact.js';
import { compareCodeUnits } from '../../../codegen/tools/canonical.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { platformMayRelaxConfirmation } from '../../../contracts/tool-policy.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import { parseToolArgs } from './args.js';
import { formatToolStatus, type ToolStatusEntry, type ToolsIo } from './format.js';

async function readOutput<T>(root: string, path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, path), 'utf8');
  } catch {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-020',
      operation: 'tools.status',
      message: 'No tool outputs found. Run glirastes tools refresh first.',
      remediation: 'run-tools-refresh',
      path,
    });
  }
  let parsed: ReturnType<typeof schema.safeParse> | undefined;
  try {
    parsed = schema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-021',
      operation: 'tools.status',
      message: 'The tool outputs are invalid. Run glirastes tools refresh.',
      remediation: 'run-tools-refresh',
      path,
    });
  }
  return parsed.data;
}

/** Local "What can my chat do?" from the committed outputs; no recomputation. */
export async function readToolStatus(root: string): Promise<ToolStatusEntry[]> {
  const artifact = await readOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema);
  const report = await readOutput(root, TOOLS_PATHS.report, ToolReportFileSchema);
  const reported = new Map(report.tools.map((tool) => [tool.toolId, tool] as const));
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
    const confirmationOrigin = tool.provenance?.policyOrigin?.requiresApproval ?? null;
    return {
      toolId: tool.toolId,
      name: tool.name,
      route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
      enabled: tool.enabled,
      needsAttention: tool.operationGroup === 'needs_attention',
      riskClass: tool.riskClass,
      confirmation: tool.requiresApproval,
      confirmationOrigin,
      platformMayRelax: tool.requiresApproval
        && platformMayRelaxConfirmation(tool.riskClass, confirmationOrigin ?? undefined),
      contractSource: entry?.contractSource ?? null,
      descriptionQuality: entry?.quality.description ?? 'template',
      schemaQuality: entry?.quality.schema ?? 'none',
    };
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

export async function runToolsStatus(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--json'], values: ['--root'] });
  const entries = await readToolStatus(resolve(io.cwd, args.values.get('--root') ?? '.'));
  io.log(args.flags.has('--json') ? JSON.stringify({ schemaVersion: 1, tools: entries }) : formatToolStatus(entries));
  return 0;
}
