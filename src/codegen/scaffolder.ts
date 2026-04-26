import { writeFile, stat } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { readFileSafe } from './fs-utils.js';
import { colors, separator, header } from './format.js';

interface ScaffoldOptions {
  /** Path to the route.ts file to scaffold from */
  routeFile: string;
  /** Root directory of the project */
  rootDir: string;
  /** File name for the tool file (default: 'ai-tool.ts') */
  toolFileName?: string;
  /** Overwrite existing file (default: false) */
  force?: boolean;
  /** Dry run — print output without writing */
  dryRun?: boolean;
}

interface RouteAnalysis {
  methods: string[];
  pathParams: string[];
  bodyFields: string[];
  searchParams: string[];
  hasZodSchema: boolean;
  apiPath: string;
}

export interface ScaffoldResult {
  code: string;
  outputPath: string;
  analysis: {
    routeFile: string;
    apiPath: string;
    methods: string[];
    module: string;
    pathParams: string[];
  };
}

/**
 * Analyze a route.ts file to extract HTTP methods, parameters, and body fields.
 */
async function analyzeRoute(routeFile: string, rootDir: string): Promise<RouteAnalysis> {
  const content = await readFileSafe(routeFile);
  if (!content) throw new Error(`File not found: ${routeFile}`);

  // Extract exported HTTP methods
  const methods: string[] = [];
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(content)) {
      methods.push(method);
    }
  }

  // Extract path params from directory structure
  const routeDir = dirname(routeFile);
  const rel = relative(rootDir, routeDir);
  const segments = rel.split(sep);
  const pathParams: string[] = [];
  const apiSegments: string[] = [];

  let inApi = false;
  for (const seg of segments) {
    if (seg === 'api') {
      inApi = true;
      apiSegments.push(seg);
      continue;
    }
    if (!inApi) continue;

    const paramMatch = seg.match(/^\[(\w+)\]$/);
    if (paramMatch) {
      pathParams.push(paramMatch[1]);
      apiSegments.push(`:${paramMatch[1]}`);
    } else {
      apiSegments.push(seg);
    }
  }

  const apiPath = '/' + apiSegments.join('/');

  // Extract body fields (from request.json() destructuring)
  const bodyFields: string[] = [];
  const bodyMatch = content.match(
    /(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:request|req)\.json\(\)/,
  );
  if (bodyMatch) {
    const fields = bodyMatch[1].split(',').map((f) => f.trim().split(':')[0].trim());
    bodyFields.push(...fields.filter(Boolean));
  }

  // Extract search params
  const searchParams: string[] = [];
  const spMatches = content.matchAll(
    /searchParams\.get\(\s*['"`](\w+)['"`]\s*\)/g,
  );
  for (const match of spMatches) {
    searchParams.push(match[1]);
  }

  // Check for Zod schema usage
  const hasZodSchema = /z\.object/.test(content);

  return { methods, pathParams, bodyFields, searchParams, hasZodSchema, apiPath };
}

/**
 * Derive tool name from API path.
 * e.g., /api/tasks/:id → get_task, /api/tasks → list_tasks
 */
function deriveToolName(method: string, apiPath: string): string {
  const segments = apiPath
    .split('/')
    .filter((s) => s && s !== 'api' && !s.startsWith(':'));

  const resource = segments[segments.length - 1] ?? 'resource';

  const prefixMap: Record<string, string> = {
    GET: segments.length === 1 ? 'list' : 'get',
    POST: 'create',
    PATCH: 'update',
    PUT: 'update',
    DELETE: 'delete',
  };

  const prefix = prefixMap[method] ?? method.toLowerCase();
  return `${prefix}_${resource}`.replace(/-/g, '_');
}

/**
 * Derive tool ID from API path.
 * e.g., /api/tasks/:id → tasks.get
 */
function deriveToolId(method: string, apiPath: string): string {
  const segments = apiPath
    .split('/')
    .filter((s) => s && s !== 'api' && !s.startsWith(':'));

  const actionMap: Record<string, string> = {
    GET: segments.length === 1 ? 'list' : 'get',
    POST: 'create',
    PATCH: 'update',
    PUT: 'update',
    DELETE: 'delete',
  };

  const action = actionMap[method] ?? method.toLowerCase();
  return `${segments.join('.')}.${action}`;
}

/**
 * Suggest module type based on API path patterns.
 */
function suggestModule(method: string, apiPath: string): string {
  const path = apiPath.toLowerCase();

  if (path.includes('/calendar') || path.includes('/events'))
    return 'calendar';
  if (path.includes('/group') || path.includes('/user') || path.includes('/member'))
    return 'group_management';
  if (path.includes('/task') || path.includes('/todo')) {
    return method === 'GET' ? 'task_query' : 'task_mutation';
  }

  return method === 'GET' ? 'task_query' : 'task_mutation';
}

/**
 * Build Zod input schema code from extracted parameters.
 */
function buildInputSchemaCode(
  pathParams: string[],
  bodyFields: string[],
  searchParams: string[],
  method: string,
): string {
  const fields: string[] = [];

  for (const param of pathParams) {
    fields.push(`    ${param}: z.string().uuid(), // path parameter`);
  }

  if (method === 'GET' || method === 'DELETE') {
    for (const param of searchParams) {
      fields.push(`    ${param}: z.string().optional(), // search param`);
    }
  } else {
    for (const field of bodyFields) {
      fields.push(`    ${field}: z.string(), // TODO: adjust type`);
    }
  }

  if (fields.length === 0) {
    return 'z.object({})';
  }

  return `z.object({\n${fields.join('\n')}\n  })`;
}

/**
 * Generate an ai-tool.ts scaffold from a route.ts file.
 * Returns a structured result with code, output path, and analysis metadata.
 */
export async function scaffoldAiTool(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const toolFileName = options.toolFileName ?? 'ai-tool.ts';
  const analysis = await analyzeRoute(options.routeFile, options.rootDir);

  if (analysis.methods.length === 0) {
    throw new Error(`No exported HTTP methods found in ${options.routeFile}`);
  }

  const toolDir = dirname(options.routeFile);
  const outputPath = join(toolDir, toolFileName);

  // Check if file already exists
  if (!options.force && !options.dryRun) {
    try {
      await stat(outputPath);
      throw new Error(
        `${toolFileName} already exists at ${outputPath}. Use --force to overwrite.`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  // Determine module (use first method's suggestion as primary)
  const primaryModule = suggestModule(analysis.methods[0], analysis.apiPath);

  // Generate tool definitions
  const tools: string[] = [];

  for (const method of analysis.methods) {
    const toolName = deriveToolName(method, analysis.apiPath);
    const toolId = deriveToolId(method, analysis.apiPath);
    const module = suggestModule(method, analysis.apiPath);
    const isMutating = method !== 'GET';
    const inputSchema = buildInputSchemaCode(
      analysis.pathParams,
      analysis.bodyFields,
      analysis.searchParams,
      method,
    );

    // Suggest uiAction
    let uiActionLine = '';
    if (isMutating) {
      const entity = analysis.apiPath
        .split('/')
        .filter((s) => s && s !== 'api' && !s.startsWith(':'))[0] ?? 'entity';
      const action =
        method === 'POST'
          ? 'created'
          : method === 'DELETE'
            ? 'deleted'
            : 'updated';

      if (analysis.pathParams.length > 0) {
        uiActionLine = `  uiActionOnSuccess: { type: '${entity.replace(/s$/, '')}-${action}', ${entity.replace(/s$/, '')}Id: '$${analysis.pathParams[0]}' },`;
      } else {
        uiActionLine = `  uiActionOnSuccess: { type: '${entity.replace(/s$/, '')}-${action}', ${entity.replace(/s$/, '')}Id: '$id' },`;
      }
    }

    tools.push(`defineEndpointTool({
  id: '${toolId}',
  toolName: '${toolName}',
  module: '${module}',
  // sharedWith: [], // TODO: add shared modules if needed
  description: '${toolName.replace(/_/g, ' ')}. TODO: write a clear description for the AI.',
  method: '${method}',
  path: '${analysis.apiPath}',
  inputSchema: ${inputSchema},
  // allowedRoles: ['admin', 'user'], // Optional: specify roles, or omit to allow all roles
  ${isMutating ? 'needsApproval: true,' : ''}
${uiActionLine ? uiActionLine : '  // uiActionOnSuccess: { type: \'...\' },'}
})`);
  }

  // Build file content
  const isSingle = tools.length === 1;
  const exportLine = isSingle
    ? `export const aiTool = ${tools[0]};`
    : `export const aiTools = [\n${tools.map((t) => `  ${t}`).join(',\n')},\n];`;

  const code = `import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

${exportLine}
`;

  if (!options.dryRun) {
    await writeFile(outputPath, code, 'utf-8');
  }

  return {
    code,
    outputPath,
    analysis: {
      routeFile: options.routeFile,
      apiPath: analysis.apiPath,
      methods: analysis.methods,
      module: primaryModule,
      pathParams: analysis.pathParams,
    },
  };
}

/**
 * Format a scaffold result as a rich, color-coded human-readable string.
 */
export function formatScaffoldResult(
  result: ScaffoldResult,
  options?: { dryRun?: boolean; rootDir?: string },
): string {
  const lines: string[] = [];
  const rootDir = options?.rootDir ?? process.cwd();

  const relRoute = relative(rootDir, result.analysis.routeFile);
  const relOutput = relative(rootDir, result.outputPath);

  // Header
  lines.push(header('Scaffold AI Tool'));

  // Analysis summary
  lines.push(`  ${colors.dim}Route:${colors.reset}   ${relRoute}`);
  lines.push(`  ${colors.dim}Path:${colors.reset}    ${result.analysis.apiPath}`);
  lines.push(`  ${colors.dim}Methods:${colors.reset} ${result.analysis.methods.join(', ')}`);
  lines.push(`  ${colors.dim}Module:${colors.reset}  ${result.analysis.module}`);
  if (result.analysis.pathParams.length > 0) {
    lines.push(`  ${colors.dim}Params:${colors.reset}  ${result.analysis.pathParams.join(', ')}`);
  }
  lines.push('');

  if (options?.dryRun) {
    lines.push(`${colors.yellow}${colors.bold}--- Dry Run (not writing) ---${colors.reset}\n`);
    lines.push(result.code);
    lines.push(`${colors.yellow}${colors.bold}--- End Dry Run ---${colors.reset}`);
  } else {
    lines.push(`${colors.green}${colors.bold}\u2705 Created:${colors.reset} ${relOutput}`);
    lines.push('');
    lines.push(`${colors.dim}Next steps:${colors.reset}`);
    lines.push(`  1. Edit ${relOutput} \u2014 fill in TODO placeholders`);
    lines.push(`  2. Run ${colors.cyan}glirastes generate-tools${colors.reset} to register`);
  }
  lines.push('');

  return lines.join('\n');
}
