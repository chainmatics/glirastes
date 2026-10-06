import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalPromptBundleSchema, type LocalPromptBundle } from '../../cli/commands/validate-build.js';
import { ToolPolicyFileSchema, type ToolPolicyFile } from '../../contracts/tool-policy.js';
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import { McpToolNamesFileSchema } from './files.js';
import { toolFinding } from './findings.js';
import { loadToolSemantics, type ToolSemantics } from './prose.js';
import { loadToolResolutions, type ToolResolutions } from './resolutions.js';
import type { McpToolName, ToolFinding } from './types.js';

export interface PromptBundleInput {
  raw: string;
  bundle: LocalPromptBundle;
}

export interface ToolInputs {
  policy: ToolPolicyFile;
  resolutions: ToolResolutions;
  semantics: ToolSemantics;
  promptBundle?: PromptBundleInput;
  /** MCP names per stable key from `.glirastes/mcp-tool-names.json`; empty without the file. */
  mcpNames?: ReadonlyMap<string, McpToolName[]>;
}

/** Reads `.glirastes/mcp-tool-names.json`; an invalid file is ignored with a warning. */
export async function readMcpToolNames(
  root: string,
): Promise<{ names: ReadonlyMap<string, McpToolName[]>; findings: ToolFinding[] }> {
  const raw = await readOptional(root, TOOLS_PATHS.mcpToolNames);
  if (raw === undefined) return { names: new Map(), findings: [] };
  let parsed: ReturnType<typeof McpToolNamesFileSchema.safeParse> | undefined;
  try {
    parsed = McpToolNamesFileSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    return {
      names: new Map(),
      findings: [toolFinding('mcp-tool-names-invalid', 'warning', TOOLS_PATHS.mcpToolNames,
        'mcp-tool-names.json is invalid and is ignored; MCP clients see the generated names.')],
    };
  }
  return { names: new Map(Object.entries(parsed.data.tools)), findings: [] };
}

async function readOptional(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function emptyToolPolicy(): ToolPolicyFile {
  return ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} });
}

export async function readPromptBundle(
  root: string,
  config: ToolsConfig,
): Promise<{ promptBundle?: PromptBundleInput; findings: ToolFinding[] }> {
  const raw = await readOptional(root, TOOLS_PATHS.promptBundle);
  if (raw === undefined) {
    return { findings: [toolFinding('prompt-bundle-missing', 'error', TOOLS_PATHS.promptBundle, 'The app has no local prompt bundle.')] };
  }
  const invalid = { findings: [toolFinding('prompt-bundle-invalid', 'error', TOOLS_PATHS.promptBundle, 'The prompt bundle is invalid or belongs to a different app.')] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid;
  }
  const parsed = LocalPromptBundleSchema.safeParse(json);
  if (!parsed.success || parsed.data.appId !== config.appId) return invalid;
  return { promptBundle: { raw, bundle: parsed.data }, findings: [] };
}

/** Reads the developer-owned inputs; the pipeline never writes any of them. */
export async function readToolInputs(
  root: string,
  config: ToolsConfig,
): Promise<{ inputs: ToolInputs; findings: ToolFinding[] }> {
  const findings: ToolFinding[] = [];
  let policy = emptyToolPolicy();
  const policyRaw = await readOptional(root, TOOLS_PATHS.policy);
  if (policyRaw !== undefined) {
    let parsed: ReturnType<typeof ToolPolicyFileSchema.safeParse> | undefined;
    try {
      parsed = ToolPolicyFileSchema.safeParse(JSON.parse(policyRaw));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) {
      policy = parsed.data;
    } else {
      // Same code as P02's parseToolPolicyFile, so CLI, doctor and Platform agree.
      findings.push(toolFinding('E-POLICY-001', 'error', TOOLS_PATHS.policy,
        'tool-policy.json is not valid; nothing is written until it is fixed.'));
    }
  }
  const resolutions = loadToolResolutions(root);
  findings.push(...resolutions.findings);
  const semantics = loadToolSemantics(root);
  findings.push(...semantics.findings);
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  const mcp = await readMcpToolNames(root);
  findings.push(...mcp.findings);
  return {
    inputs: {
      policy,
      resolutions: resolutions.resolutions,
      semantics: semantics.semantics,
      ...(prompt.promptBundle ? { promptBundle: prompt.promptBundle } : {}),
      mcpNames: mcp.names,
    },
    findings,
  };
}
