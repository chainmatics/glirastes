import { join, dirname } from 'node:path';
import {
  findFiles,
  findRouteFiles,
  hasAiIgnore,
  isDirAiIgnored,
  readFileSafe,
  extractBalancedBlocks,
} from './fs-utils.js';
import type { GenerateOptions } from './types.js';
import { resolveDefaults } from './types.js';
import { colors, separator, header } from './format.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  file: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  passed: boolean;
}

/**
 * Validate AI tool configuration across the project.
 *
 * Checks:
 * 1. All API routes have an ai-tool.ts file (unless @ai-ignore)
 * 2. All component directories with UI have ai-ui-tool.ts (unless @ai-ignore)
 * 3. No orphaned ai-tool.ts files without corresponding route.ts
 * 4. Tool files have required exports
 * 5. Path consistency between file location and defined endpoint path
 * 6. Module field is present in tool definitions
 * 7. NestJS controllers have @AiTool decorators (unless @ai-ignore)
 */
export async function validateAiTools(
  options: GenerateOptions,
): Promise<ValidationResult> {
  const opts = resolveDefaults(options);
  const issues: ValidationIssue[] = [];

  // 1. Check routes have ai-tool.ts
  const apiDir = join(opts.rootDir, opts.apiDir);
  const routeFiles = await findRouteFiles(apiDir);

  for (const routeFile of routeFiles) {
    const routeContent = await readFileSafe(routeFile);
    if (routeContent.includes('@ai-ignore')) continue;

    const routeDir = dirname(routeFile);
    if (await isDirAiIgnored(routeDir)) continue;
    const toolFile = join(routeDir, opts.endpointToolFileName);
    const toolContent = await readFileSafe(toolFile);

    const relFile = routeFile.replace(opts.rootDir + '/', '');

    if (!toolContent && !routeContent.includes('withAiTool(')) {
      issues.push({
        severity: 'warning',
        file: relFile,
        message: `Route without ${opts.endpointToolFileName}`,
        suggestion: `glirastes scaffold --route "${relFile}"`,
      });
    }
  }

  // 2. Check ai-tool.ts files have corresponding route.ts
  const toolFiles = await findFiles(apiDir, opts.endpointToolFileName);

  for (const toolFile of toolFiles) {
    const toolDir = dirname(toolFile);
    const routeFile = join(toolDir, 'route.ts');
    const routeContent = await readFileSafe(routeFile);
    const relFile = toolFile.replace(opts.rootDir + '/', '');

    if (!routeContent) {
      const routeRelFile = routeFile.replace(opts.rootDir + '/', '');
      issues.push({
        severity: 'error',
        file: relFile,
        message: `${opts.endpointToolFileName} has no corresponding route.ts`,
        suggestion: `Create ${routeRelFile} or remove ${relFile}`,
      });
    }
  }

  // 3. Check tool files have required exports
  for (const toolFile of toolFiles) {
    const content = await readFileSafe(toolFile);
    if (content.includes('@ai-ignore')) continue;

    const relFile = toolFile.replace(opts.rootDir + '/', '');
    const hasArrayExport = /export\s+const\s+aiTools\s*[=:]/m.test(content);
    const hasSingleExport = /export\s+const\s+aiTool\s*[=:]/m.test(content);

    if (!hasArrayExport && !hasSingleExport) {
      issues.push({
        severity: 'error',
        file: relFile,
        message: `Missing export: expected 'export const aiTools' or 'export const aiTool'`,
        suggestion: `Add 'export const aiTool = defineEndpointTool({...})'`,
      });
    }

    // Check for description
    if (!content.includes('description')) {
      issues.push({
        severity: 'warning',
        file: relFile,
        message: 'Tool definition is missing a description',
        suggestion: `Add description with usage hints for the AI`,
      });
    }
  }

  // 4. Check path consistency and module field
  for (const toolFile of toolFiles) {
    const content = await readFileSafe(toolFile);
    if (content.includes('@ai-ignore')) continue;

    const relPath = toolFile.replace(opts.rootDir + '/', '');

    // Extract path values from tool definitions
    const pathMatches = content.matchAll(
      /path\s*:\s*['"`]([^'"`]+)['"`]/g,
    );
    for (const match of pathMatches) {
      const definedPath = match[1];
      // Derive expected path from file location: src/app/api/tasks/[id]/subtasks/ai-tool.ts → /api/tasks/:id/subtasks
      const expectedPath = '/' + dirname(relPath)
        .replace(/^src\/app\//, '')
        .replace(/\[([^\]]+)\]/g, ':$1'); // convert [param] to :param

      // Check that the defined path starts with the expected base
      if (!definedPath.startsWith(expectedPath.replace(/\/+$/, ''))) {
        issues.push({
          severity: 'warning',
          file: relPath,
          message: `Path '${definedPath}' doesn't match file location '${expectedPath}'`,
          suggestion: `Update path to '${expectedPath}'`,
        });
      }
    }

    // Check for module field presence (brace-balanced)
    const toolBlocksArr = extractBalancedBlocks(
      content,
      /define(?:Ai)?EndpointTool\(\s*/,
    );
    for (const block of toolBlocksArr) {
      const hasModule = /module\s*:/.test(block);
      if (!hasModule) {
        const toolNameMatch = block.match(
          /toolName\s*:\s*['"`]([^'"`]+)['"`]/,
        );
        const toolName = toolNameMatch?.[1] ?? 'unknown';
        issues.push({
          severity: 'info',
          file: relPath,
          message: `Tool '${toolName}' has no module field`,
          suggestion: `Add module: 'task_query' | 'task_mutation' | 'navigation' | ...`,
        });
      }
    }
  }

  // 5. Check UI tool files have required exports
  const componentsDir = join(opts.rootDir, opts.componentsDir);
  const uiToolFiles = await findFiles(componentsDir, opts.uiToolFileName);

  for (const uiToolFile of uiToolFiles) {
    const content = await readFileSafe(uiToolFile);
    if (content.includes('@ai-ignore')) continue;

    const relFile = uiToolFile.replace(opts.rootDir + '/', '');
    const hasExport = /export\s+const\s+aiUiTools\s*[=:]/m.test(content);
    if (!hasExport) {
      issues.push({
        severity: 'error',
        file: relFile,
        message: `Missing export: expected 'export const aiUiTools'`,
        suggestion: `Add 'export const aiUiTools = [defineUiTool({...})]'`,
      });
    }

    // Check module field in UI tool definitions (brace-balanced)
    const uiToolBlocksArr = extractBalancedBlocks(
      content,
      /define(?:Ai)?UiTool\(\s*/,
    );
    for (const block of uiToolBlocksArr) {
      const hasModule = /module\s*:/.test(block);
      if (!hasModule) {
        const toolNameMatch = block.match(
          /toolName\s*:\s*['"`]([^'"`]+)['"`]/,
        );
        const toolName = toolNameMatch?.[1] ?? 'unknown';
        issues.push({
          severity: 'info',
          file: relFile,
          message: `UI tool '${toolName}' has no module field`,
          suggestion: `Add module field for intent-based routing`,
        });
      }
    }
  }

  // 6. Check NestJS controllers have @AiTool decorators
  if (opts.nestjsDirs.length > 0) {
    const { scanNestControllers } = await import('./nestjs-scanner.js');
    const nestResult = await scanNestControllers(opts.nestjsDirs, opts.nestjsApiPrefix);

    for (const ctrl of nestResult.uncoveredControllers) {
      const relFile = ctrl.controllerFile.replace(opts.rootDir + '/', '');
      issues.push({
        severity: 'warning',
        file: relFile,
        message: `${ctrl.controllerName} has ${ctrl.httpMethodCount} HTTP endpoint(s) but no @AiTool decorators`,
        suggestion: `Add @AiModule + @AiTool decorators, or add // @ai-ignore to exclude`,
      });
    }
  }

  // Tally results
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;

  return {
    issues,
    errorCount,
    warningCount,
    infoCount,
    passed: errorCount === 0,
  };
}

/**
 * Format a validation result as a rich, color-coded human-readable string.
 */
export function formatValidationReport(
  result: ValidationResult,
  options?: { quiet?: boolean; showFix?: boolean },
): string {
  if (options?.quiet && result.issues.length === 0) {
    return `${colors.green}\u2713${colors.reset} AI tools validation passed`;
  }

  const lines: string[] = [];

  // Header
  lines.push(header('AI Tools Validation'));

  // No issues
  if (result.issues.length === 0) {
    lines.push(`${colors.green}\u2705 All AI tools are properly configured!${colors.reset}`);
    lines.push('');
    return lines.join('\n');
  }

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const infos = result.issues.filter((i) => i.severity === 'info');

  // Errors
  if (errors.length > 0) {
    lines.push(`${colors.red}${colors.bold}\u274C ${errors.length} Error(s):${colors.reset}\n`);
    for (const issue of errors) {
      lines.push(`  ${colors.red}\u274C${colors.reset} ${colors.bold}${issue.file}${colors.reset}`);
      lines.push(`     ${issue.message}`);
      if (issue.suggestion) {
        lines.push(`     ${colors.cyan}\u2192 ${issue.suggestion}${colors.reset}`);
      }
      lines.push('');
    }
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push(`${colors.yellow}${colors.bold}\u26A0\uFE0F  ${warnings.length} Warning(s):${colors.reset}\n`);
    for (const issue of warnings) {
      lines.push(`  ${colors.yellow}\u26A0\uFE0F${colors.reset}  ${colors.bold}${issue.file}${colors.reset}`);
      lines.push(`     ${issue.message}`);
      if (issue.suggestion) {
        lines.push(`     ${colors.cyan}\u2192 ${issue.suggestion}${colors.reset}`);
      }
      lines.push('');
    }
  }

  // Info (only when not quiet)
  if (infos.length > 0 && !options?.quiet) {
    lines.push(`${colors.blue}${colors.bold}\u2139\uFE0F  ${infos.length} Info(s):${colors.reset}\n`);
    for (const issue of infos) {
      lines.push(`  ${colors.blue}\u2139\uFE0F${colors.reset}  ${colors.bold}${issue.file}${colors.reset}`);
      lines.push(`     ${issue.message}`);
      if (issue.suggestion) {
        lines.push(`     ${colors.cyan}\u2192 ${issue.suggestion}${colors.reset}`);
      }
      lines.push('');
    }
  }

  // Quick fix section
  if (options?.showFix) {
    const missingAiTools = result.issues.filter(
      (i) => i.severity === 'warning' && i.suggestion?.startsWith('glirastes scaffold'),
    );
    if (missingAiTools.length > 0) {
      lines.push(`${colors.cyan}${colors.bold}Quick Fix:${colors.reset}`);
      lines.push(`${colors.dim}Run scaffold command for missing ai-tool.ts files:${colors.reset}\n`);
      for (const issue of missingAiTools) {
        lines.push(`  ${colors.cyan}${issue.suggestion}${colors.reset}`);
      }
      lines.push('');
    }
  }

  // Summary line
  lines.push(`${colors.dim}Summary: ${result.errorCount} errors, ${result.warningCount} warnings, ${result.infoCount} infos${colors.reset}`);
  lines.push('');

  return lines.join('\n');
}
