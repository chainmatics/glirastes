import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findFiles, findRouteFiles, toImportPath, readFileSafe, isDirAiIgnored } from './fs-utils.js';
import type { GenerateOptions, ScanResult, DiscoveredFile } from './types.js';
import { resolveDefaults } from './types.js';
import type { DiscoveredNestTool } from './nestjs-scanner.js';

/**
 * Scan for endpoint tool files (ai-tool.ts) in the API directory.
 * Also detects route.ts files using withAiTool() from glirastes/server/nextjs.
 */
export async function scanEndpointTools(
  options: GenerateOptions,
): Promise<ScanResult> {
  const opts = resolveDefaults(options);
  const apiDir = join(opts.rootDir, opts.apiDir);
  const files = await findFiles(apiDir, opts.endpointToolFileName);

  const discovered: DiscoveredFile[] = [];
  const discoveredDirs = new Set<string>();

  // 1. Standard ai-tool.ts files
  for (const absolutePath of files) {
    const content = await readFileSafe(absolutePath);
    if (content.includes('@ai-ignore')) continue;
    if (await isDirAiIgnored(dirname(absolutePath))) continue;

    const hasArray = /export\s+const\s+aiTools\s*[=:]/m.test(content);
    const hasSingle = /export\s+const\s+aiTool\s*[=:]/m.test(content);

    if (!hasArray && !hasSingle) continue;

    discovered.push({
      absolutePath,
      relativePath: absolutePath.replace(opts.rootDir + '/', ''),
      importPath: toImportPath(absolutePath, opts.rootDir),
      exportType: hasArray ? 'array' : 'single',
    });
    discoveredDirs.add(dirname(absolutePath));
  }

  // 2. route.ts files with withAiTool() (inline tool definitions)
  const routeFiles = await findRouteFiles(apiDir);
  for (const routeFile of routeFiles) {
    const routeDir = dirname(routeFile);
    if (discoveredDirs.has(routeDir)) continue; // Already has ai-tool.ts

    const content = await readFileSafe(routeFile);
    if (content.includes('@ai-ignore')) continue;
    if (await isDirAiIgnored(routeDir)) continue;
    if (!content.includes('withAiTool(')) continue;

    discovered.push({
      absolutePath: routeFile,
      relativePath: routeFile.replace(opts.rootDir + '/', ''),
      importPath: toImportPath(routeFile, opts.rootDir),
      exportType: 'single', // withAiTool wraps a single handler
    });
  }

  // Count tools (rough estimate: arrays have multiple, singles have 1)
  let toolCount = 0;
  for (const file of discovered) {
    if (file.exportType === 'array') {
      const content = await readFileSafe(file.absolutePath);
      // Count defineEndpointTool or defineAiEndpointTool calls
      const matches = content.match(/define(?:Ai)?EndpointTool\(/g);
      toolCount += matches?.length ?? 1;
    } else {
      toolCount += 1;
    }
  }

  return { files: discovered, toolCount };
}

/**
 * Generate the endpoint tools registry file.
 *
 * Output: a TypeScript file that imports all discovered endpoint tools and
 * combines them into a single registry via endpointToolsToRegistry().
 */
export async function generateEndpointRegistry(
  options: GenerateOptions,
): Promise<{ outputPath: string; toolCount: number }> {
  const opts = resolveDefaults(options);
  const scan = await scanEndpointTools(options);

  // NestJS @AiTool decorated controllers
  let nestTools: DiscoveredNestTool[] = [];
  if (opts.nestjsDirs.length > 0) {
    const { scanNestControllers } = await import('./nestjs-scanner.js');
    const nestResult = await scanNestControllers(opts.nestjsDirs, opts.nestjsApiPrefix);
    nestTools = nestResult.tools;
  }

  const imports: string[] = [];
  const spreadParts: string[] = [];

  scan.files.forEach((file, index) => {
    if (file.exportType === 'array') {
      const alias = `endpointTools${index}`;
      imports.push(
        `import { aiTools as ${alias} } from '${file.importPath}';`,
      );
      spreadParts.push(`...${alias}`);
    } else {
      const alias = `endpointTool${index}`;
      imports.push(
        `import { aiTool as ${alias} } from '${file.importPath}';`,
      );
      spreadParts.push(alias);
    }
  });

  // Generate inline defineEndpointTool() calls for NestJS tools
  const nestInlineDefs: string[] = [];
  const nestSpreadParts: string[] = [];

  nestTools.forEach((tool, index) => {
    const alias = `nestTool${index}`;
    const desc = tool.description.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Build path param schema fields (e.g. { id: z.string() })
    const paramFields = tool.pathParams.map(p => `${p}: z.string()`).join(', ');
    const inputSchema = paramFields
      ? `z.object({ ${paramFields} }).passthrough()`
      : 'z.object({}).passthrough()';
    const lines = [
      `  id: '${tool.name}'`,
      `  toolName: '${tool.name}'`,
      `  description: '${desc}'`,
      `  path: '${tool.path}'`,
      `  method: '${tool.method}'`,
      `  inputSchema: ${inputSchema}`,
    ];
    if (tool.module) lines.push(`  module: '${tool.module}'`);
    if (tool.needsApproval !== undefined) lines.push(`  needsApproval: ${tool.needsApproval}`);
    if (tool.allowedRoles && tool.allowedRoles.length > 0) {
      lines.push(`  allowedRoles: ${JSON.stringify(tool.allowedRoles)}`);
    }
    nestInlineDefs.push(`const ${alias} = defineEndpointTool({\n${lines.join(',\n')},\n});`);
    nestSpreadParts.push(alias);
  });

  const allSpreadParts = [...spreadParts, ...nestSpreadParts];
  const totalToolCount = scan.toolCount + nestTools.length;

  const contractsImport = nestTools.length > 0
    ? `import { z } from 'zod';\nimport { defineEndpointTool } from 'glirastes';\n`
    : '';

  const nestInlineBlock = nestInlineDefs.length > 0
    ? `\n// From NestJS @AiTool decorators\n${nestInlineDefs.join('\n\n')}\n`
    : '';

  const code = `/* eslint-disable */
/**
 * AUTO-GENERATED FILE — do not edit manually.
 * Generated by glirastes
 *
 * Sources: ${scan.files.length} ai-tool.ts files, ${nestTools.length} NestJS @AiTool decorators
 * Tools: ${totalToolCount}
 */

${imports.join('\n')}
import { endpointToolsToRegistry } from 'glirastes/server';
${contractsImport}${nestInlineBlock}
const endpointTools = [${allSpreadParts.join(', ')}] as const;

export { endpointTools };
export const endpointToolRegistry = endpointToolsToRegistry(endpointTools);
`;

  const outputPath = join(
    opts.rootDir,
    opts.outputDir,
    'endpoint.generated.ts',
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, code, 'utf-8');

  if (!opts.quiet) {
    console.log(
      `✓ Generated ${outputPath} (${totalToolCount} endpoint tools from ${scan.files.length} files + ${nestTools.length} NestJS controllers)`,
    );
  }

  return { outputPath, toolCount: totalToolCount };
}
