import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  findFiles,
  findRouteFiles,
  readFileSafe,
  getSubdirectories,
  isDirAiIgnored,
  hasAiIgnore,
  extractBalancedBlocks,
} from './fs-utils.js';
import { scanEndpointTools } from './endpoint-scanner.js';
import { scanUiTools, extractActionIds } from './ui-scanner.js';
import type { GenerateOptions } from './types.js';
import { resolveDefaults } from './types.js';
import { colors, separator, header, metricLine, sectionHeader } from './format.js';

export interface CoverageReport {
  endpointToolCount: number;
  endpointFileCount: number;
  uiToolCount: number;
  uiFileCount: number;
  actionIdCount: number;
  routeTotal: number;
  routeCovered: number;
  routeIgnored: number;
  routeCoveragePercent: number;
  componentDirTotal: number;
  componentDirCovered: number;
  componentDirIgnored: number;
  componentCoveragePercent: number;
  sharedWithConfigs: Array<{
    toolName: string;
    primaryModule: string;
    sharedWith: string[];
  }>;
  /** Handler coverage: how many actionIds have registered handlers in source */
  handlerActionIds: string[];
  handlerCoveredCount: number;
  handlerTotalCount: number;
  handlerCoveragePercent: number;
  /** Orphan handlers: useAiClientAction calls without a matching UI tool actionId */
  orphanHandlers: Array<{ actionId: string; sourceFile: string }>;
  /** Routes without a corresponding ai-tool.ts (relative paths) */
  uncoveredRoutes: string[];
  /** Component directories without ai-ui-tool.ts (relative paths) */
  uncoveredComponents: string[];
  /** Action IDs that have no registered useAiClientAction handler */
  missingHandlers: Array<{
    actionId: string;
    toolName: string;
    sourceFile: string;
  }>;
  /** NestJS controller coverage */
  nestControllerTotal: number;
  nestControllerCovered: number;
  nestControllerIgnored: number;
  nestControllerCoveragePercent: number;
  /** Number of @AiTool-decorated methods found across NestJS controllers */
  nestToolCount: number;
  /** NestJS controllers found without @AiTool decorators (not ignored) */
  uncoveredNestControllers: Array<{
    controllerFile: string;
    controllerName: string;
    httpMethodCount: number;
  }>;
}

/**
 * Check AI tool coverage across the project.
 * Reports on endpoint tools, UI tools, route coverage,
 * component coverage, and sharedWith configurations.
 */
export async function checkAiCoverage(
  options: GenerateOptions,
): Promise<CoverageReport> {
  const opts = resolveDefaults(options);

  // Scan tools
  const endpointScan = await scanEndpointTools(options);
  const uiScan = await scanUiTools(options);
  const actionIds = await extractActionIds(options);

  // NestJS controller coverage
  let nestControllerTotal = 0;
  let nestControllerCovered = 0;
  let nestControllerIgnored = 0;
  let nestToolCount = 0;
  const uncoveredNestControllers: CoverageReport['uncoveredNestControllers'] = [];

  if (opts.nestjsDirs.length > 0) {
    const { scanNestControllers } = await import('./nestjs-scanner.js');
    const nestResult = await scanNestControllers(opts.nestjsDirs, opts.nestjsApiPrefix);

    // Count unique controller files that have tools
    const coveredFiles = new Set(nestResult.tools.map(t => t.controllerFile));
    nestControllerCovered = coveredFiles.size;
    nestToolCount = nestResult.tools.length;
    uncoveredNestControllers.push(...nestResult.uncoveredControllers);
    nestControllerTotal = nestControllerCovered + uncoveredNestControllers.length;
  }

  // Route coverage
  const apiDir = join(opts.rootDir, opts.apiDir);
  const routeFiles = await findRouteFiles(apiDir);
  const toolFiles = new Set(
    (await findFiles(apiDir, opts.endpointToolFileName)).map((f) =>
      f.replace(`/${opts.endpointToolFileName}`, ''),
    ),
  );

  let routeCovered = 0;
  let routeIgnored = 0;
  const uncoveredRoutes: string[] = [];

  for (const routeFile of routeFiles) {
    const routeDir = routeFile.replace('/route.ts', '');
    const routeContent = await readFileSafe(routeFile);

    if (routeContent.includes('@ai-ignore') || await isDirAiIgnored(routeDir)) {
      routeIgnored++;
      continue;
    }

    if (toolFiles.has(routeDir) || routeContent.includes('withAiTool(')) {
      routeCovered++;
    } else {
      uncoveredRoutes.push(routeFile.replace(opts.rootDir + '/', ''));
    }
  }

  const routeTotal = routeFiles.length - routeIgnored;

  // Component coverage
  const componentsDir = join(opts.rootDir, opts.componentsDir);
  const componentDirs = await getSubdirectories(componentsDir);
  const uiToolDirs = new Set(
    (
      await findFiles(componentsDir, opts.uiToolFileName)
    ).map((f) => f.replace(`/${opts.uiToolFileName}`, '')),
  );

  let componentDirCovered = 0;
  let componentDirIgnored = 0;
  const uncoveredComponents: string[] = [];

  for (const dir of componentDirs) {
    if (await isDirAiIgnored(dir)) {
      componentDirIgnored++;
      continue;
    }

    if (uiToolDirs.has(dir)) {
      componentDirCovered++;
    } else {
      uncoveredComponents.push(dir.replace(opts.rootDir + '/', ''));
    }
  }

  const componentDirTotal = componentDirs.length - componentDirIgnored;

  // SharedWith analysis
  const sharedWithConfigs: CoverageReport['sharedWithConfigs'] = [];
  for (const file of endpointScan.files) {
    const content = await readFileSafe(file.absolutePath);
    const toolBlocksArr = extractBalancedBlocks(
      content,
      /define(?:Ai)?EndpointTool\(\s*/,
    );

    for (const block of toolBlocksArr) {
      const sharedMatch = block.match(/sharedWith\s*:\s*\[([^\]]*)\]/);
      if (!sharedMatch) continue;

      const toolNameMatch = block.match(
        /toolName\s*:\s*['"`]([^'"`]+)['"`]/,
      );
      const moduleMatch = block.match(
        /module\s*:\s*['"`]([^'"`]+)['"`]/,
      );
      if (!toolNameMatch) continue;

      const sharedWith = sharedMatch[1]
        .match(/['"`]([^'"`]+)['"`]/g)
        ?.map((s) => s.replace(/['"`]/g, ''));

      if (sharedWith && sharedWith.length > 0) {
        sharedWithConfigs.push({
          toolName: toolNameMatch[1],
          primaryModule: moduleMatch?.[1] ?? 'unknown',
          sharedWith,
        });
      }
    }
  }

  // Handler source-scan: find useAiClientAction() calls in .tsx files
  // In monorepos, scan all configured dirs + default src/
  const handlerScanDirs = [
    join(opts.rootDir, 'src'),
    ...(opts.nestjsDirs ?? []),
    join(opts.rootDir, opts.componentsDir),
  ].filter((d, i, arr) => arr.indexOf(d) === i); // dedupe
  const tsxFiles: string[] = [];
  for (const dir of handlerScanDirs) {
    tsxFiles.push(...await findTsxFiles(dir));
  }
  const requiredActionIds = new Set(actionIds.map((a) => a.actionId));
  const foundHandlerIds = new Set<string>();
  const allSourceHandlers: Array<{ actionId: string; sourceFile: string }> = [];

  for (const tsxFile of tsxFiles) {
    const content = await readFileSafe(tsxFile);
    if (content.includes('@ai-ignore')) continue;

    // Match useAiClientAction('actionId', ...) calls
    const handlerMatches = content.matchAll(
      /useAiClientAction\(\s*['"`]([^'"`]+)['"`]/g,
    );
    for (const m of handlerMatches) {
      const actionId = m[1];
      foundHandlerIds.add(actionId);
      allSourceHandlers.push({
        actionId,
        sourceFile: tsxFile.replace(opts.rootDir + '/', ''),
      });
    }
  }

  const handlerCoveredCount = Array.from(requiredActionIds).filter(
    (id) => foundHandlerIds.has(id),
  ).length;
  const handlerTotalCount = requiredActionIds.size;

  // Orphan handlers: registered in source but no matching UI tool actionId
  const orphanHandlers = allSourceHandlers.filter(
    (h) => !requiredActionIds.has(h.actionId),
  );

  // Missing handlers: actionIds defined in UI tools but no useAiClientAction found
  const missingHandlers = actionIds
    .filter((a) => !foundHandlerIds.has(a.actionId))
    .map((a) => ({
      actionId: a.actionId,
      toolName: a.toolName,
      sourceFile: a.sourceFile,
    }));

  return {
    endpointToolCount: endpointScan.toolCount,
    endpointFileCount: endpointScan.files.length,
    uiToolCount: uiScan.toolCount,
    uiFileCount: uiScan.files.length,
    actionIdCount: actionIds.length,
    routeTotal,
    routeCovered,
    routeIgnored,
    routeCoveragePercent:
      routeTotal > 0 ? Math.round((routeCovered / routeTotal) * 100) : 100,
    componentDirTotal,
    componentDirCovered,
    componentDirIgnored,
    componentCoveragePercent:
      componentDirTotal > 0
        ? Math.round((componentDirCovered / componentDirTotal) * 100)
        : 100,
    sharedWithConfigs,
    handlerActionIds: Array.from(foundHandlerIds),
    handlerCoveredCount,
    handlerTotalCount,
    handlerCoveragePercent:
      handlerTotalCount > 0
        ? Math.round((handlerCoveredCount / handlerTotalCount) * 100)
        : 100,
    orphanHandlers,
    uncoveredRoutes,
    uncoveredComponents,
    missingHandlers,
    nestControllerTotal,
    nestControllerCovered,
    nestControllerIgnored,
    nestControllerCoveragePercent: nestControllerTotal > 0
      ? Math.round((nestControllerCovered / nestControllerTotal) * 100)
      : 100,
    nestToolCount,
    uncoveredNestControllers,
  };
}

/**
 * Recursively find all .tsx files in a directory.
 */
async function findTsxFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(fullPath);
      } else if (entry.name.endsWith('.tsx')) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

/**
 * Format a coverage report as a rich, color-coded human-readable string.
 */
export function formatCoverageReport(
  report: CoverageReport,
  options?: { quiet?: boolean },
): string {
  if (options?.quiet) {
    return formatCoverageReportQuiet(report);
  }

  const lines: string[] = [];
  const hasHandlerIssues = report.missingHandlers.length > 0;
  const hasOrphanHandlers = report.orphanHandlers.length > 0;
  const hasRouteIssues = report.uncoveredRoutes.length > 0;
  const hasComponentIssues = report.uncoveredComponents.length > 0;
  const hasNestIssues = report.uncoveredNestControllers.length > 0;
  const hasIssues = hasHandlerIssues || hasOrphanHandlers || hasRouteIssues || hasComponentIssues || hasNestIssues;

  // Detect active frameworks from scan results
  const hasNextRoutes = report.routeTotal > 0 || report.endpointFileCount > 0;
  const hasNest = report.nestControllerTotal > 0 || report.nestToolCount > 0;

  // Header
  lines.push(header('AI Tools Coverage Summary'));

  // Endpoint Tools — framework-adaptive detail
  const totalEndpointTools = report.endpointToolCount + report.nestToolCount;
  const endpointParts: string[] = [];
  if (hasNextRoutes || (!hasNest && report.endpointFileCount === 0)) {
    endpointParts.push(`${report.endpointFileCount} route files`);
  }
  if (hasNest) {
    endpointParts.push(`${report.nestControllerCovered} controllers`);
  }
  lines.push(metricLine(
    '\u2713', colors.green,
    'Endpoint Tools:',
    totalEndpointTools,
    endpointParts.join(' + '),
  ));

  lines.push(metricLine(
    '\u2713', colors.green,
    'UI Tools (ai-ui-tool.ts):',
    report.uiToolCount,
    `${report.uiFileCount} files`,
  ));

  const handlerIcon = hasHandlerIssues ? '\u26A0' : '\u2713';
  const handlerColor = hasHandlerIssues ? colors.yellow : colors.green;
  lines.push(metricLine(
    handlerIcon, handlerColor,
    'Handler Coverage:',
    `${report.handlerCoveragePercent}%`,
    `${report.handlerCoveredCount}/${report.handlerTotalCount}`,
  ));

  // Route Coverage — only show when Next.js routes exist or are expected
  if (hasNextRoutes) {
    const routeIcon = hasRouteIssues ? '\u26A0' : '\u2713';
    const routeColor = hasRouteIssues ? colors.yellow : colors.green;
    lines.push(metricLine(
      routeIcon, routeColor,
      'Route Coverage:',
      `${report.routeCoveragePercent}%`,
      `${report.routeCovered}/${report.routeTotal} routes${report.routeIgnored > 0 ? `, ${report.routeIgnored} ignored` : ''}`,
    ));
  }

  const componentIcon = hasComponentIssues ? '\u26A0' : '\u2713';
  const componentColor = hasComponentIssues ? colors.yellow : colors.green;
  lines.push(metricLine(
    componentIcon, componentColor,
    'Component Coverage:',
    `${report.componentCoveragePercent}%`,
    `${report.componentDirCovered}/${report.componentDirTotal} dirs${report.componentDirIgnored > 0 ? `, ${report.componentDirIgnored} ignored` : ''}`,
  ));

  // NestJS Decorator Coverage — only show when NestJS is detected
  if (hasNest) {
    const nestIcon = report.uncoveredNestControllers.length > 0 ? '\u26A0' : '\u2713';
    const nestColor = report.uncoveredNestControllers.length > 0 ? colors.yellow : colors.green;
    lines.push(metricLine(
      nestIcon, nestColor,
      'Decorator Coverage (@AiTool):',
      `${report.nestControllerCoveragePercent}%`,
      `${report.nestControllerCovered}/${report.nestControllerTotal} controllers`,
    ));
  }

  const sharedCount = report.sharedWithConfigs.length;
  lines.push(metricLine(
    '\u2713', colors.green,
    'Cross-Module Sharing:',
    sharedCount > 0 ? `${sharedCount} Tools` : 'None',
  ));

  lines.push('');
  lines.push(separator());

  // --- Detail sections (conditional) ---

  // Missing handlers
  if (hasHandlerIssues) {
    lines.push('');
    lines.push(sectionHeader('Missing Handlers', report.missingHandlers.length, colors.red));
    for (const h of report.missingHandlers) {
      lines.push(
        `  ${colors.red}\u2717${colors.reset} ${colors.bold}${h.actionId}${colors.reset}` +
        `  ${colors.dim}\u2190 ${h.toolName}${colors.reset}`,
      );
      lines.push(`    ${colors.dim}Defined in: ${h.sourceFile}${colors.reset}`);
    }
  }

  // Orphan handlers
  if (hasOrphanHandlers) {
    lines.push('');
    lines.push(sectionHeader('Orphan Handlers', report.orphanHandlers.length, colors.yellow));
    lines.push(`${colors.dim}These handlers have no corresponding UI tool definition:${colors.reset}`);
    for (const o of report.orphanHandlers) {
      lines.push(
        `  ${colors.yellow}\u26A0${colors.reset} ${colors.bold}${o.actionId}${colors.reset}` +
        `  ${colors.dim}\u2192 ${o.sourceFile}${colors.reset}`,
      );
    }
  }

  // Uncovered routes
  if (hasRouteIssues) {
    lines.push('');
    lines.push(sectionHeader('Routes without ai-tool.ts', report.uncoveredRoutes.length, colors.yellow));
    for (const route of report.uncoveredRoutes) {
      lines.push(`  ${colors.yellow}\u26A0${colors.reset} ${route}`);
      lines.push(`    ${colors.cyan}\u2192 glirastes scaffold --route "${route}"${colors.reset}`);
    }
    lines.push(`\n${colors.dim}Or add // @ai-ignore to route.ts to exclude${colors.reset}`);
  }

  // Uncovered components
  if (hasComponentIssues) {
    lines.push('');
    lines.push(sectionHeader('Components without ai-ui-tool.ts', report.uncoveredComponents.length, colors.yellow));
    for (const dir of report.uncoveredComponents) {
      lines.push(`  ${colors.yellow}\u26A0${colors.reset} ${dir}/`);
      lines.push(`    ${colors.cyan}\u2192 Create ${dir}/ai-ui-tool.ts${colors.reset}`);
    }
    lines.push(`\n${colors.dim}Or add // @ai-ignore to any .ts/.tsx file or create .ai-ignore to exclude${colors.reset}`);
  }

  // Uncovered NestJS controllers
  if (report.uncoveredNestControllers.length > 0) {
    lines.push('');
    lines.push(sectionHeader('NestJS controllers without @AiTool', report.uncoveredNestControllers.length, colors.yellow));
    lines.push(`${colors.dim}These controllers have HTTP endpoints but no @AiTool decorators:${colors.reset}`);
    for (const ctrl of report.uncoveredNestControllers) {
      const relPath = ctrl.controllerFile.includes('/src/')
        ? ctrl.controllerFile.slice(ctrl.controllerFile.indexOf('/src/') + 1)
        : ctrl.controllerFile;
      lines.push(
        `  ${colors.yellow}\u26A0${colors.reset} ${colors.bold}${ctrl.controllerName}${colors.reset}` +
        `  ${colors.dim}(${ctrl.httpMethodCount} endpoints)${colors.reset}`,
      );
      lines.push(`    ${colors.dim}${relPath}${colors.reset}`);
      lines.push(`    ${colors.cyan}\u2192 Add @AiModule + @AiTool decorators, or create .ai-ignore to exclude${colors.reset}`);
    }
  }

  // SharedWith configurations (when no issues — show as positive info)
  if (sharedCount > 0 && !hasIssues) {
    lines.push('');
    lines.push(sectionHeader('Cross-Module Sharing', sharedCount, colors.green));
    for (const config of report.sharedWithConfigs) {
      lines.push(
        `  ${colors.green}\u2713${colors.reset} ${colors.bold}${config.toolName}${colors.reset}` +
        `  ${colors.dim}(${config.primaryModule})${colors.reset}` +
        `  \u2192 ${config.sharedWith.join(', ')}`,
      );
    }
  }

  // Final summary
  lines.push('');
  lines.push(separator());
  lines.push('');

  const totalTools = report.endpointToolCount + report.uiToolCount + report.nestToolCount;
  const summaryIcon = hasIssues ? '\u26A0\uFE0F' : '\u2705';
  const summaryColor = hasIssues ? colors.yellow : colors.green;
  lines.push(`${summaryColor}${summaryIcon} Total: ${colors.bold}${totalTools} AI Tools${colors.reset}`);
  lines.push('');

  // Framework-adaptive summary lines
  if (hasNextRoutes) {
    lines.push(`  ${colors.dim}Routes:      ${report.routeCovered}/${report.routeTotal} have ai-tool.ts (${report.endpointToolCount} tools)${colors.reset}`);
  }
  if (hasNest) {
    lines.push(`  ${colors.dim}Controllers: ${report.nestControllerCovered}/${report.nestControllerTotal} have @AiTool decorators (${report.nestToolCount} tools)${colors.reset}`);
  }
  lines.push(`  ${colors.dim}Components:  ${report.componentDirCovered}/${report.componentDirTotal} have ai-ui-tool.ts (${report.uiToolCount} tools)${colors.reset}`);
  lines.push(`  ${colors.dim}Handlers:    ${report.handlerCoveredCount}/${report.handlerTotalCount} actionIds have useAiClientAction${colors.reset}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Minimal quiet output for predev/prebuild hooks.
 */
function formatCoverageReportQuiet(report: CoverageReport): string {
  const issues: string[] = [];

  if (report.uncoveredRoutes.length > 0) {
    issues.push(`${report.uncoveredRoutes.length} uncovered routes`);
  }
  if (report.uncoveredComponents.length > 0) {
    issues.push(`${report.uncoveredComponents.length} uncovered components`);
  }
  if (report.missingHandlers.length > 0) {
    issues.push(`${report.missingHandlers.length} missing handlers`);
  }
  if (report.orphanHandlers.length > 0) {
    issues.push(`${report.orphanHandlers.length} orphan handlers`);
  }
  if (report.uncoveredNestControllers.length > 0) {
    issues.push(`${report.uncoveredNestControllers.length} uncovered NestJS controllers`);
  }

  if (issues.length === 0) {
    return `${colors.green}\u2713${colors.reset} AI coverage: ${report.endpointToolCount + report.uiToolCount + report.nestToolCount} tools, all OK`;
  }

  return `${colors.yellow}\u26A0${colors.reset} AI coverage: ${issues.join(', ')}`;
}
