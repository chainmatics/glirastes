import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lockDigest } from '../../../codegen/tools/agentic.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import type { ToolsPipelineTool } from '../../../codegen/tools/pipeline.js';
import { ResolutionEntrySchema, resolutionLockDigest } from '../../../codegen/tools/resolutions.js';
import { isAgenticSemantics, SEMANTICS_FIELDS, SemanticsEntrySchema, type ToolSemanticsEntry } from '../../../codegen/tools/semantics.js';
import type { ToolFinding } from '../../../codegen/tools/types.js';
import { writeArtifactSetAtomically } from '../atomic-artifact-write.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import type { ToolsIo } from './format.js';

export const VERIFY_ARGS = { flags: ['--all'], values: ['--root'], positionals: 500 } as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(root: string, path: string): Promise<JsonRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rejectedIn(tool: ToolsPipelineTool, file: string): boolean {
  return tool.findings.some((finding) => finding.code === 'resolution-rejected' && finding.message.includes(file));
}

/** The generator ignores these files wholesale when they do not parse: none of their entries is accepted. */
const IGNORED_FILE_FINDINGS: ReadonlyArray<{ code: string; file: string }> = [
  { code: 'resolution-rejected', file: TOOLS_PATHS.resolutions },
  { code: 'tool-semantics-invalid', file: TOOLS_PATHS.semantics },
];

/** An early return of verify: the findings, then why nothing was verified; exit 2. */
function refuse(io: ToolsIo, findings: ReadonlyArray<ToolFinding>, why: string): number {
  for (const finding of findings) {
    io.error(`${finding.subjectRef}  ${finding.code}: ${finding.message}`);
    io.error(`  Next: ${finding.nextAction}`);
  }
  io.error(`Nothing was verified: ${why}`);
  return 2;
}

/** The entry is current when the generator reads the tool's interface and the entry was written for exactly that one. */
function writtenForCurrentInterface(tool: ToolsPipelineTool, digest: string | undefined): boolean {
  return tool.interfaceDigest !== null && digest === tool.interfaceDigest;
}

/** Pins a reviewed agent resolution: origin human, `locked` = digest of the entry. */
function verifyResolution(raw: unknown): { entry: JsonRecord; interfaceDigest: string } | undefined {
  const parsed = ResolutionEntrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.origin !== 'agent') return undefined;
  const reviewed = { ...parsed.data, origin: 'human' as const };
  return {
    entry: { ...(raw as JsonRecord), origin: 'human', locked: resolutionLockDigest(reviewed) },
    interfaceDigest: parsed.data.interfaceDigest,
  };
}

/** Turns every agent field of a semantics entry into a reviewed, locked human field. */
function verifySemantics(entry: JsonRecord): { entry: JsonRecord; interfaceDigest: string | undefined } | undefined {
  const parsed = SemanticsEntrySchema.safeParse(entry);
  if (!parsed.success || !isAgenticSemantics(entry)) return undefined;
  const origin = { ...(isRecord(entry.origin) ? entry.origin : {}) };
  const locked = { ...(isRecord(entry.locked) ? entry.locked : {}) };
  for (const field of SEMANTICS_FIELDS) {
    if (origin[field] !== 'agent') continue;
    origin[field] = 'human';
    // The generator compares the parsed value, so the digest is taken from it.
    locked[field] = lockDigest(parsed.data[field] ?? null);
  }
  const { agent: _agent, ...rest } = entry;
  return { entry: { ...rest, origin, locked }, interfaceDigest: parsed.data.agent?.interfaceDigest };
}

/**
 * `glirastes tools verify <tool|--all>` (spec 4.2): the developer confirms
 * agent-written contracts and descriptions after review. They become human
 * entries pinned by digest; a later agent edit is rejected until the next
 * review. Only entries the generator accepts can be verified.
 */
export async function runToolsVerify(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, VERIFY_ARGS);
  if (args.flags.has('--all') === (args.positionals.length > 0)) {
    throw new ToolsUsageError('Name the tools to verify, or use --all for every tool an agent described.');
  }
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const result = await io.runPipeline({ root, mode: 'frozen', keepGoing: true });
  const tools = result.tools ?? [];
  // Drift of the committed outputs is expected while an agent edits the entries; it does not stop the tool list.
  const errors = result.findings.filter((finding) => finding.severity === 'error' && finding.code !== 'tool-outputs-drift');
  if (tools.length === 0 && errors.length > 0) {
    return refuse(io, errors, 'the generator stopped before it listed the tools. Fix the errors above and run glirastes tools check.');
  }
  const ignored = result.findings.filter((finding) => IGNORED_FILE_FINDINGS
    .some((entry) => entry.code === finding.code && entry.file === finding.subjectRef));
  if (ignored.length > 0) {
    return refuse(io, ignored, 'the generator ignores the file named above, so none of its entries is accepted. Fix the file and run glirastes tools check.');
  }
  const resolutions = await readJson(root, TOOLS_PATHS.resolutions);
  const semantics = await readJson(root, TOOLS_PATHS.semantics);
  const resolutionTools = isRecord(resolutions?.tools) ? { ...resolutions.tools } : {};
  const semanticsTools = Array.isArray(semantics?.tools) ? [...semantics.tools] : [];
  // The generator keys the last parsable entry by its parsed (trimmed)
  // stableKey, then by its name (loadToolSemantics); verify must lock that
  // entry, never one it shadows.
  const lastEntryIndex = (matches: (entry: ToolSemanticsEntry) => boolean) => {
    for (let index = semanticsTools.length - 1; index >= 0; index -= 1) {
      const parsed = SemanticsEntrySchema.safeParse(semanticsTools[index]);
      if (parsed.success && matches(parsed.data)) return index;
    }
    return -1;
  };
  const semanticsIndex = (tool: ToolsPipelineTool) => {
    const byKey = lastEntryIndex((entry) => entry.stableKey === tool.stableKey);
    return byKey >= 0 ? byKey : lastEntryIndex((entry) => entry.name === tool.definitionId);
  };
  const selected = args.flags.has('--all')
    ? tools.filter((tool) => verifyResolution(resolutionTools[tool.stableKey]) !== undefined
      || (semanticsIndex(tool) >= 0 && isAgenticSemantics(semanticsTools[semanticsIndex(tool)])))
    : args.positionals.map((name) => {
      const tool = tools.find((candidate) => candidate.definitionId === name || candidate.stableKey === name);
      if (!tool) throw new ToolsUsageError(`Unknown tool ${name}; glirastes tools status lists the names.`);
      return tool;
    });
  const verified: string[] = [];
  for (const tool of selected) {
    const parts: string[] = [];
    // A tool whose handler the generator cannot read has no interface to compare an entry with.
    const unreadable = (file: string) => new ToolsUsageError(
      `The ${file} entry of ${tool.definitionId} cannot be checked: the generator cannot read the handler of this tool. `
      + 'Fix the handler and run glirastes tools refresh before verifying.',
    );
    const resolution = verifyResolution(resolutionTools[tool.stableKey]);
    if (resolution) {
      if (tool.interfaceDigest === null) throw unreadable('tool-resolutions.json');
      if (rejectedIn(tool, 'tool-resolutions.json') || !writtenForCurrentInterface(tool, resolution.interfaceDigest)) {
        throw new ToolsUsageError(`The tool-resolutions.json entry of ${tool.definitionId} is rejected or stale; fix it and refresh before verifying.`);
      }
      resolutionTools[tool.stableKey] = resolution.entry;
      parts.push('contract');
    }
    const index = semanticsIndex(tool);
    const description = index >= 0 && isRecord(semanticsTools[index]) ? verifySemantics(semanticsTools[index] as JsonRecord) : undefined;
    if (description) {
      if (tool.interfaceDigest === null) throw unreadable('tool-semantics.json');
      if (tool.semantics.rejected || !writtenForCurrentInterface(tool, description.interfaceDigest)) {
        throw new ToolsUsageError(`The tool-semantics.json entry of ${tool.definitionId} is rejected or stale; fix it and refresh before verifying.`);
      }
      semanticsTools[index] = description.entry;
      parts.push('description');
    }
    if (parts.length === 0) throw new ToolsUsageError(`${tool.definitionId} has no agent-written entry to verify.`);
    verified.push(`${tool.definitionId} (${parts.join(' and ')})`);
  }
  const writes = [
    ...(resolutions ? [{ path: resolve(root, TOOLS_PATHS.resolutions), content: render({ ...resolutions, tools: resolutionTools }) }] : []),
    ...(semantics ? [{ path: resolve(root, TOOLS_PATHS.semantics), content: render({ ...semantics, tools: semanticsTools }) }] : []),
  ];
  if (verified.length > 0) await writeArtifactSetAtomically(writes);
  io.log(verified.length > 0
    ? `Verified ${verified.join(', ')}: reviewed and locked. Run glirastes tools refresh.`
    : 'No agent-written entries to verify.');
  return 0;
}
