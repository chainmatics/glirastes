import { posix } from 'node:path';
import type { AppSetupArtifact } from '../../contracts/index.js';
import type { ToolSearchSemantics } from '../../runtime/tool-discovery.js';
import { compareCodeUnits, sortKeysDeep } from './canonical.js';
import { deriveChatInteractions } from './chat-interactions.js';
import type { RuntimeSchemaSource, ToolContract, ToolContractsEntry } from './types.js';

export interface RenderGeneratedModuleInput {
  modulePath: string;
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
  /** `emit.mcpCatalog`: also export `createMcpEndpointCatalog()` for the app's MCP server. */
  mcpCatalog?: boolean;
  /** `emit.moduleResolution` of a `.ts` module; `bundler` when absent. */
  moduleResolution?: 'bundler' | 'nodenext';
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function accessor(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

/** The file a NodeNext import names: what the source compiles to (`schemas.ts` → `schemas.js`). */
const NODENEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  '.ts': '.js', '.tsx': '.js', '.mts': '.mjs', '.cts': '.cjs',
};

function importSpecifier(
  fromModule: string,
  target: string,
  typescript: boolean,
  moduleResolution: 'bundler' | 'nodenext',
): string {
  let specifier = posix.relative(posix.dirname(fromModule), target);
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  if (!typescript) return specifier;
  if (moduleResolution === 'nodenext') {
    return specifier.replace(/\.(?:ts|tsx|mts|cts)$/, (extension) => NODENEXT_EXTENSIONS[extension]!);
  }
  return specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
}

function literal(value: unknown, indent = 0): string {
  const text = JSON.stringify(sortKeysDeep(value), null, 2);
  return indent > 0 ? text.replace(/\n/g, `\n${' '.repeat(indent)}`) : text;
}

type ArtifactTool = AppSetupArtifact['tools'][number];

/**
 * The search-only semantics of one tool contract (`search` of
 * tool-contracts.json): synonyms and example sentences, `undefined` when it
 * has neither. Shared by the generated module and the container artifact.
 */
export function toolSearchSemanticsOf(search: ToolContractsEntry['search']): ToolSearchSemantics | undefined {
  const synonyms = search?.synonyms ?? [];
  const examples = search?.examples ?? [];
  if (synonyms.length === 0 && examples.length === 0) return undefined;
  return {
    ...(synonyms.length > 0 ? { synonyms: [...synonyms] } : {}),
    ...(examples.length > 0 ? { examples: [...examples] } : {}),
  };
}

function catalogEntry(tool: ArtifactTool): Record<string, unknown> {
  const common = {
    toolId: tool.toolId,
    definitionId: tool.name,
    modelName: tool.modelName ?? tool.name.replace(/\./g, '_'),
    executionKind: tool.executionKind,
    sourceFingerprint: tool.sourceFingerprint,
    inputSchemaDigest: tool.inputSchemaDigest,
    outputSchemaDigest: tool.outputSchemaDigest,
    description: tool.description,
    riskClass: tool.riskClass,
    requiresApproval: tool.requiresApproval,
  };
  return tool.executionKind === 'endpoint'
    ? { ...common, method: tool.method, path: tool.path }
    : { ...common, actionBindingRef: tool.actionBindingRef };
}

/** Pure function of artifact, contracts and module path; integrity mode re-renders it byte for byte. */
export function renderGeneratedModule(input: RenderGeneratedModuleInput): string {
  const typescript = input.modulePath.endsWith('.ts');
  const contractsById = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools = input.artifact.tools
    .filter((tool) => tool.enabled)
    .sort((left, right) => compareCodeUnits(left.toolId, right.toolId));
  const bound = tools.map((tool) => {
    const contract: ToolContract | null | undefined = contractsById.get(tool.toolId)?.contract;
    const entry = contractsById.get(tool.toolId);
    const maxResultChars = entry?.maxResultChars;
    // Output fields bound endpoint results only; a UI tool has no backend answer.
    const outputFields = tool.executionKind === 'endpoint'
      ? ([['outputAllowedFields', entry?.outputAllowedFields], ['outputDeniedFields', entry?.outputDeniedFields],
        ['outputDefaultFields', entry?.outputDefaultFields]] as const)
        .filter((field): field is readonly [typeof field[0], string[]] => field[1] !== undefined)
      : [];
    if (!contract) throw new Error(`Enabled tool ${tool.name} has no contract to bind.`);
    if (tool.executionKind === 'ui' && !contract.uiAction) {
      throw new Error(`Enabled UI tool ${tool.name} has no UI action to bind.`);
    }
    return { tool, contract, maxResultChars, outputFields };
  });
  // Search-only synonyms and examples of the enabled tools, keyed like `toolSemantics` of createAiChatHandler.
  const searchSemantics = Object.fromEntries(tools
    .map((tool) => [catalogEntry(tool).modelName as string, toolSearchSemanticsOf(contractsById.get(tool.toolId)?.search)] as const)
    .filter((entry): entry is readonly [string, ToolSearchSemantics] => entry[1] !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  // Labels per language (tools.json languages), keyed like toolSearchSemantics; absent for an app without languages.
  const toolTexts = Object.fromEntries(tools
    .map((tool) => [catalogEntry(tool).modelName as string, contractsById.get(tool.toolId)?.labels] as const)
    .filter((entry): entry is readonly [string, NonNullable<ToolContractsEntry['labels']>] => entry[1] !== undefined)
    .map(([name, labels]) => [name, { labels }] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  const modules = [...new Set(bound
    .flatMap(({ contract }) => [contract.runtime.input, contract.runtime.output])
    .flatMap((source) => (source.kind === 'module-export' ? [source.module] : [])))]
    .sort(compareCodeUnits);
  const aliases = new Map(modules.map((module, index) => [module, `m${index}`] as const));
  const usesJson = bound.some(({ contract }) => contract.runtime.input.kind === 'json' || contract.runtime.output.kind === 'json');
  const usesEndpoints = bound.some(({ tool }) => tool.executionKind === 'endpoint');
  const usesUi = bound.some(({ tool }) => tool.executionKind === 'ui');
  const expression = (source: RuntimeSchemaSource): string => (source.kind === 'json'
    ? `createJsonSchemaLike(${literal(source.schema, 2)})`
    : `${aliases.get(source.module)!}${[source.export, ...source.property].map(accessor).join('')}`);
  const serverImports = [
    ...(usesEndpoints ? ['endpointToolToTool'] : []),
    ...(usesUi ? ['uiActionToolToTool'] : []),
  ];

  const lines: string[] = [
    '// @generated by `glirastes tools refresh`. Do not edit; rerun the command after code changes.',
    '/* eslint-disable */',
  ];
  if (usesJson) lines.push("import { createJsonSchemaLike } from 'glirastes/runtime';");
  if (serverImports.length > 0) lines.push(`import { ${serverImports.join(', ')} } from 'glirastes/server';`);
  for (const module of modules) {
    const specifier = importSpecifier(input.modulePath, module, typescript, input.moduleResolution ?? 'bundler');
    lines.push(`import * as ${aliases.get(module)!} from ${JSON.stringify(specifier)};`);
  }
  lines.push(
    '',
    `export const setupArtifact = ${literal(input.artifact)};`,
    '',
    `export const toolCatalog = ${literal(tools.map(catalogEntry))}${typescript ? ' as const' : ''};`,
    '',
    '/** `@` entities and `/` commands derived from the tools; see `createChatInteractionsHandler`. */',
    `export const chatInteractions = ${literal(deriveChatInteractions(input))}${typescript ? ' as const' : ''};`,
    '',
  );
  if (typescript) {
    lines.push(`export type GeneratedToolId = ${tools.length > 0
      ? tools.map((tool) => JSON.stringify(tool.toolId)).join(' | ')
      : 'never'};`, '');
  }
  // The emitted comment stays as it was (examples now take part too), so a
  // module of an app without examples stays byte-identical.
  lines.push(
    '/** Pass as `toolSemantics` to createAiChatHandler: synonyms help find_tools, they never grant a tool. */',
    `export const toolSearchSemantics = ${literal(searchSemantics)}${typescript ? ' as const' : ''};`,
    '',
  );
  if (Object.keys(toolTexts).length > 0) {
    lines.push(
      '/** Labels per language for the chat (tools.json `languages`); `chatTurn()` passes them on as `toolTexts`. */',
      `export const toolTexts = ${literal(toolTexts)}${typescript ? ' as const' : ''};`,
      '',
    );
  }
  lines.push('export function createToolBindings() {');
  if (bound.length === 0) {
    lines.push('  return [];');
  } else {
    bound.forEach(({ contract }, index) => {
      lines.push(`  const input${index} = ${expression(contract.runtime.input)};`);
      lines.push(`  const output${index} = ${expression(contract.runtime.output)};`);
    });
    lines.push('  return [');
    bound.forEach(({ tool, contract, maxResultChars, outputFields }, index) => {
      const entry = `toolCatalog[${index}]`;
      const shared = [
        `        id: ${entry}.definitionId,`,
        `        toolName: ${entry}.modelName,`,
        `        description: ${entry}.description,`,
      ];
      const toolExpression = tool.executionKind === 'endpoint'
        ? [
          '      tool: endpointToolToTool({',
          ...shared,
          `        method: ${entry}.method,`,
          `        path: ${entry}.path,`,
          `        inputSchema: input${index},`,
          ...(contract.runtime.output.kind === 'module-export' ? [`        outputSchema: output${index},`] : []),
          `        needsApproval: ${entry}.requiresApproval,`,
          ...(maxResultChars !== undefined ? [`        maxResultChars: ${maxResultChars},`] : []),
          ...outputFields.map(([name, paths]) => `        ${name}: ${literal(paths, 8)},`),
          '      }),',
        ]
        : [
          '      tool: uiActionToolToTool({',
          ...shared,
          `        inputSchema: input${index},`,
          `        needsApproval: ${entry}.requiresApproval,`,
          `        action: ${literal(contract.uiAction, 8)},`,
          '      }),',
        ];
      lines.push(
        '    {',
        `      ...${entry},`,
        `      inputSchema: input${index},`,
        `      outputSchema: output${index},`,
        ...toolExpression,
        '    },',
      );
    });
    lines.push('  ];');
  }
  lines.push('}', '');
  if (input.mcpCatalog === true) {
    // MCP only (spec 5.6): enabled endpoint tools under the names MCP clients keep; UI tools stay out.
    const mcpEntries = bound
      .flatMap(({ tool, contract }) => {
        if (tool.executionKind !== 'endpoint') return [];
        const entry = catalogEntry(tool);
        const names = contractsById.get(tool.toolId)?.mcp ?? [{ id: tool.name, name: entry.modelName as string }];
        return names.map((name) => ({ name, tool, contract, entry }));
      })
      .sort((left, right) => compareCodeUnits(left.name.name, right.name.name));
    lines.push(
      '/** For the app\'s MCP server only (`emit.mcpCatalog`): endpoint tools under their MCP grant ids and names. */',
      'export function createMcpEndpointCatalog() {',
    );
    if (mcpEntries.length === 0) {
      lines.push('  return [];');
    } else {
      lines.push('  return [');
      for (const { name, tool, contract, entry } of mcpEntries) {
        const data = literal({
          id: name.id,
          name: name.name,
          toolId: tool.toolId,
          definitionId: tool.name,
          method: entry.method,
          path: entry.path,
          description: entry.description,
          riskClass: tool.riskClass,
          requiresApproval: tool.requiresApproval,
          allowedRoles: tool.allowedRoles,
          inputJsonSchema: contract.input,
        }, 4);
        const schema = expression(contract.runtime.input).replace(/\n/g, '\n    ');
        // A replacer function: `$$`, `$&` or `$'` inside the schema text must not be read as replacement patterns.
        lines.push(`    ${data.replace(/\n {4}\}$/, () => `,\n      "inputSchema": ${schema}\n    }`)},`);
      }
      lines.push('  ];');
    }
    lines.push('}', '');
  }
  return lines.join('\n');
}
