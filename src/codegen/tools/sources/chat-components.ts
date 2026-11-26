import ts from 'typescript';
import {
  chatComponentManifestSchema,
  type ChatComponentManifest,
  type ChatComponentManifestEntry,
} from '../../../contracts/chat-view.js';
import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import { createAppProgram } from '../program.js';
import { probeKey } from '../contract-tiers.js';
import type { SchemaProbe, SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type { ToolFinding } from '../types.js';
import { defaultSourceDir, scanAppSources } from './app-files.js';
import { importedCalls } from './ui-tools.js';

export interface ChatComponentScanOptions {
  /** Where definitions are searched; `src` when the app has one, else the app root. */
  srcDir?: string;
  /** The tsconfig of those files; the nearest one from `srcDir` up to the app root by default. */
  tsconfig?: string;
}

export interface ChatComponentScan {
  /** The app's own components (starter entries excluded); undefined when the app defines none. */
  manifest?: ChatComponentManifest;
  findings: ToolFinding[];
}

const DEFINITION_TEXT = 'defineChatComponent';
const IMPORTS = [{ module: 'glirastes', names: [DEFINITION_TEXT] }];

/** The export a `defineChatComponent(...)` call is bound to: `export const x = ...` or `export default ...`. */
function exportedAs(call: ts.CallExpression): string | undefined {
  let node: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.parent;
  if (ts.isExportAssignment(node) && !node.isExportEquals) return 'default';
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  const list = node.parent;
  const statement = list.parent;
  if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement)) return undefined;
  const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return exported ? node.name.text : undefined;
}

const keyOf = (entry: ChatComponentManifestEntry): string => `${entry.id}@${entry.schemaVersion}`;

/**
 * The app's `defineChatComponent` definitions as a component manifest. Each
 * exported definition is imported by the schema probe and turned into its
 * entry by the SDK's own `toChatComponentManifest`.
 */
export async function scanChatComponents(
  root: string,
  probe: SchemaProbe,
  options: ChatComponentScanOptions = {},
): Promise<ChatComponentScan> {
  const findings: ToolFinding[] = [];
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: () => true,
  });
  if (!scan.complete) {
    findings.push(toolFinding('chat-components-unscanned', 'warning', 'chat-components',
      `Chat components were not collected: ${scan.reason}.`));
    return { findings };
  }
  const files = scan.files.filter((file) => file.source.includes(DEFINITION_TEXT));
  if (files.length === 0) return { findings };
  const app = createAppProgram({
    root,
    rootNames: files.map((file) => file.absolute),
    searchFrom: options.srcDir ?? defaultSourceDir(root),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
  const items = new Map<string, { item: SchemaProbeItem; where: string }>();
  for (const file of files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const { call } of importedCalls(source, IMPORTS)) {
      const where = `${file.path}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}`;
      const name = exportedAs(call);
      if (name === undefined) {
        findings.push(toolFinding('chat-component-not-exported', 'warning', where,
          'A chat component is defined without being exported, so it cannot be collected into the manifest.'));
        continue;
      }
      const item: SchemaProbeItem = { kind: 'chat-component', io: 'input', module: file.path, export: name, property: [] };
      items.set(probeKey(item), { item, where });
    }
  }
  const keys = [...items.keys()].sort(compareCodeUnits);
  if (keys.length === 0) return { findings };
  const results = await probe.probe(root, keys.map((key) => items.get(key)!.item), { tsconfig: app.tsconfigPath ?? null });
  const entries = new Map<string, { entry: ChatComponentManifestEntry; where: string }>();
  keys.forEach((key, index) => {
    const { item, where } = items.get(key)!;
    const result: SchemaProbeResult = results[index] ?? { ok: false, reason: 'probe-failed' };
    if (!result.ok && result.reason === 'unsupported-schema') {
      // The SDK's own message names the fix (import z from 'zod/v4').
      findings.push(toolFinding('chat-component-invalid', 'error', where,
        `The chat component ${item.module}#${item.export} uses a schema that is not zod 4: ${result.detail ?? ''}`.trim()));
      return;
    }
    if (!result.ok || result.kind !== 'chat-component') {
      const reason = result.ok ? 'unexpected-result' : result.reason;
      const detail = !result.ok && result.detail ? `: ${result.detail}` : '';
      findings.push(toolFinding('chat-component-invalid', 'error', where,
        `The chat component ${item.module}#${item.export} could not be read (${reason})${detail}.`));
      return;
    }
    for (const entry of result.manifest.components) {
      const existing = entries.get(keyOf(entry));
      if (existing) {
        findings.push(toolFinding('chat-component-invalid', 'error', where,
          `The chat component ${keyOf(entry)} is also defined at ${existing.where}.`));
        continue;
      }
      entries.set(keyOf(entry), { entry, where });
    }
  });
  if (findings.some((finding) => finding.severity === 'error') || entries.size === 0) return { findings };
  const components = [...entries.values()]
    .map(({ entry }) => entry)
    .sort((left, right) => compareCodeUnits(keyOf(left), keyOf(right)));
  return { manifest: chatComponentManifestSchema.parse({ v: 1, components }), findings };
}

export function renderChatComponentManifest(manifest: ChatComponentManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
