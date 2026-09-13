import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateReference, tenantId } from './adapter.mjs';

/** Single atomic build artifact: persistent identities and statically bound runtime. */
export async function buildReference(rootDir) {
  rootDir = await realpath(rootDir);
  const directory = resolve(rootDir, '.glirastes');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error('Generation directory must be app-local, not linked');
  }
  const output = resolve(directory, 'runtime.mjs');
  try {
    const stat = await lstat(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generation artifact must be app-local, not linked');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let previous;
  try {
    const text = await readFile(output, 'utf8');
    const match = text.match(/^export const generationState = (.+);$/m);
    if (!match) throw new Error('Invalid previous generation; restore its last good artifact');
    previous = JSON.parse(match[1]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const generated = await generateReference({ rootDir, previous });
  const { state, artifact, limits } = generated;
  const imports = [
    "import { z } from 'zod';",
    "import { createLocalRuntimeSource } from 'glirastes/runtime';",
    "import { endpointToolToTool, uiToolToTool } from 'glirastes/server';",
  ];
  if (state.inventory.executions.some((entry) => entry.executionKind === 'ui')) {
    imports.push("import config from '../src/ui-config.json' with { type: 'json' };",
      "import { createUiContracts } from '../src/ui.js';", 'const ui = createUiContracts(config);');
  }
  const bindings = state.inventory.executions.map((entry, index) => {
    const candidate = artifact.tools.find((tool) => tool.toolId === entry.toolId);
    const common = { id: entry.definitionId, toolName: candidate.modelName,
      description: candidate.description, needsApproval: false };
    let tool;
    if (entry.executionKind === 'endpoint') {
      const contract = `../${posix.join(posix.dirname(entry.sourceFile), 'contract.js')}`;
      imports.push(`import { inputSchema as input${index}, outputSchema as output${index} } from ${JSON.stringify(contract)};`);
      tool = `endpointToolToTool({ ...${JSON.stringify(common)}, method: ${JSON.stringify(entry.method)}, path: ${JSON.stringify(entry.path)}, inputSchema: input${index}, outputSchema: output${index} })`;
    } else {
      const isFilter = entry.definitionId === 'ui.filter';
      const uiAction = { type: 'native-ui', actionId: entry.actionId,
        payload: isFilter ? { view: '$view', filters: '$filters' } : { view: '$view' } };
      tool = `uiToolToTool({ ...${JSON.stringify(common)}, inputSchema: ui.${isFilter ? 'filterSchema' : 'navigationSchema'}, outputSchema: z.object({ success: z.literal(true) }), uiAction: ${JSON.stringify(uiAction)} })`;
    }
    return `{ ...${JSON.stringify(entry)}, tool: ${tool} }`;
  });
  const source = [
    '// Generated locally from native source. Do not edit or send to the Platform.',
    ...imports,
    `export const generationState = ${JSON.stringify(state)};`,
    `export const tenantId = ${JSON.stringify(tenantId)};`,
    `export const bindings = [${bindings.join(',\n')}];`,
    `export const source = createLocalRuntimeSource({ setupArtifact: ${JSON.stringify(artifact)}, bindings, localLimits: ${JSON.stringify(limits)}, identity: { tenantId } });`,
    '',
  ].join('\n');
  const pending = `${output}.${randomUUID()}.pending`;
  try { await writeFile(pending, source, { flag: 'wx' }); await rename(pending, output); }
  finally { await rm(pending, { force: true }); }
  return generated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildReference(resolve(process.argv[2] ?? '.'));
  console.log('Local source bindings verified and generated. No Platform sync or activation.');
}
