import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractBalancedBlocks, isDirAiIgnored } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredNestTool {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full path, e.g. /api/users/:id */
  path: string;
  /** From @AiModule intent */
  module?: string;
  /** Absolute path to the controller file */
  controllerFile: string;
  /** Extracted from route segments starting with ':' */
  pathParams: string[];
  /** Whether tool requires human approval (defaults to true for mutations) */
  needsApproval?: boolean;
  /** Roles that may call this tool (empty = all roles) */
  allowedRoles?: string[];
}

export interface UncoveredNestController {
  /** Absolute path to the controller file */
  controllerFile: string;
  /** Controller class name (extracted from `class XxxController`) */
  controllerName: string;
  /** Number of HTTP method decorators (@Get, @Post, etc.) found */
  httpMethodCount: number;
}

export interface NestScanResult {
  tools: DiscoveredNestTool[];
  modules: Array<{
    intent: string;
    hint?: string;
    examples?: string[];
    controllerFile: string;
  }>;
  uncoveredControllers: UncoveredNestController[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPath(
  apiPrefix: string,
  controllerPath: string,
  methodPath: string,
): string {
  const parts = [apiPrefix, controllerPath, methodPath].filter(Boolean);
  const joined = parts.join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return '/' + joined;
}

function extractPathParams(path: string): string[] {
  return (path.match(/:(\w+)/g) || []).map((p) => p.slice(1));
}

/**
 * Recursively find all `*.controller.ts` files in a directory,
 * skipping `node_modules` and `.git`.
 */
async function findControllerFiles(dir: string): Promise<string[]> {
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
      } else if (entry.name.endsWith('.controller.ts')) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

// ---------------------------------------------------------------------------
// HTTP-method decorator detection
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const HTTP_DECORATOR_RE =
  /@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"]\s*)?\)/g;

interface HttpDecoratorMatch {
  method: HttpMethod;
  subRoute: string;
  index: number;
}

function findHttpDecorators(content: string): HttpDecoratorMatch[] {
  const matches: HttpDecoratorMatch[] = [];
  const re = new RegExp(HTTP_DECORATOR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches.push({
      method: m[1]!.toUpperCase() as HttpMethod,
      subRoute: m[2] ?? '',
      index: m.index,
    });
  }
  return matches;
}

/**
 * For a given character index in `content`, find the nearest preceding HTTP
 * method decorator.
 */
function nearestHttpDecorator(
  decorators: HttpDecoratorMatch[],
  position: number,
): HttpDecoratorMatch | undefined {
  let best: HttpDecoratorMatch | undefined;
  for (const d of decorators) {
    if (d.index < position) {
      if (!best || d.index > best.index) {
        best = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseControllerPath(content: string): string {
  const m = content.match(/@Controller\(\s*['"]([^'"]*)['"]\s*\)/);
  return m?.[1] ?? '';
}

interface AiModuleMeta {
  intent: string;
  hint?: string;
  examples?: string[];
}

function parseAiModule(content: string): AiModuleMeta | undefined {
  const blocks = extractBalancedBlocks(content, /@AiModule\(\s*/);
  if (blocks.length === 0) return undefined;

  const block = blocks[0]!;

  const intentMatch = block.match(/intent:\s*['"]([^'"]+)['"]/);
  if (!intentMatch) return undefined;

  const hint = block.match(/hint:\s*['"]([^'"]+)['"]/)?.[1];

  let examples: string[] | undefined;
  const examplesMatch = block.match(/examples:\s*\[([^\]]*)\]/);
  if (examplesMatch) {
    const inner = examplesMatch[1]!;
    examples = [];
    const strRe = /['"]([^'"]+)['"]/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(inner)) !== null) {
      examples.push(sm[1]!);
    }
  }

  return { intent: intentMatch[1]!, hint, examples };
}

interface AiToolRaw {
  name: string;
  description: string;
  needsApproval?: boolean;
  allowedRoles?: string[];
  /** Character index where the @AiTool decorator starts in the source */
  sourceIndex: number;
}

function parseAiTools(content: string): AiToolRaw[] {
  const tools: AiToolRaw[] = [];

  // We need to know the source index of each @AiTool match.
  // extractBalancedBlocks doesn't expose offsets, so we locate them manually.
  const aiToolRe = /@AiTool\(\s*/g;
  let prefixMatch: RegExpExecArray | null;

  while ((prefixMatch = aiToolRe.exec(content)) !== null) {
    const searchStart = prefixMatch.index + prefixMatch[0].length;
    const braceStart = content.indexOf('{', searchStart);
    if (braceStart === -1) continue;

    // Balanced-brace walk
    let depth = 0;
    let i = braceStart;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      if (depth === 0) break;
    }

    if (depth !== 0) continue;

    const inner = content.slice(braceStart + 1, i);

    const nameMatch = inner.match(/name:\s*['"`]([^'"`]+)['"`]/);
    const descMatch = inner.match(/description:\s*['"]([^'"]+)['"]/)
      || inner.match(/description:\s*`([\s\S]*?)`/);

    if (nameMatch) {
      const description = (descMatch?.[1] ?? descMatch?.[2] ?? '').replace(/\s+/g, ' ').trim();

      // Extract needsApproval (boolean literal)
      const approvalMatch = inner.match(/needsApproval:\s*(true|false)/);
      const needsApproval = approvalMatch ? approvalMatch[1] === 'true' : undefined;

      // Extract allowedRoles (string array)
      let allowedRoles: string[] | undefined;
      const rolesMatch = inner.match(/allowedRoles:\s*\[([^\]]*)\]/);
      if (rolesMatch) {
        allowedRoles = [];
        const roleRe = /['"`]([^'"`]+)['"`]/g;
        let rm: RegExpExecArray | null;
        while ((rm = roleRe.exec(rolesMatch[1]!)) !== null) {
          allowedRoles.push(rm[1]!);
        }
      }

      tools.push({
        name: nameMatch[1]!,
        description,
        needsApproval,
        allowedRoles,
        sourceIndex: prefixMatch.index,
      });
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

/**
 * Scan NestJS controller files for `@AiTool` and `@AiModule` decorator
 * metadata using static regex analysis (no runtime reflection).
 *
 * @param dirs        Directories to scan recursively for `*.controller.ts` files.
 * @param apiPrefix   Optional global route prefix (e.g. `'api'`).
 */
export async function scanNestControllers(
  dirs: string[],
  apiPrefix: string = '',
): Promise<NestScanResult> {
  const result: NestScanResult = { tools: [], modules: [], uncoveredControllers: [] };

  // 1. Collect all controller files from every directory
  const allFiles: string[] = [];
  for (const dir of dirs) {
    const files = await findControllerFiles(dir);
    allFiles.push(...files);
  }

  // 2. Parse each controller
  for (const filePath of allFiles) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Check ignore markers — only skip file when @ai-ignore appears before
    // the first import/class (file-level ignore). Method-level // @ai-ignore
    // comments are fine — methods without @AiTool are already skipped.
    const preamble = content.slice(0, content.search(/^(?:import|@Controller|@Module|export\s+class)\b/m) >>> 0 || 200);
    if (preamble.includes('@ai-ignore')) continue;
    if (await isDirAiIgnored(dirname(filePath))) continue;

    // Controller base path
    const controllerPath = parseControllerPath(content);

    // Module metadata
    const moduleMeta = parseAiModule(content);
    if (moduleMeta) {
      result.modules.push({
        ...moduleMeta,
        controllerFile: filePath,
      });
    }

    // Tool metadata
    const rawTools = parseAiTools(content);
    if (rawTools.length === 0) {
      // Check if this controller has HTTP endpoints that should have @AiTool
      const httpDecorators = findHttpDecorators(content);
      if (httpDecorators.length > 0) {
        const classMatch = content.match(/class\s+(\w+)/);
        result.uncoveredControllers.push({
          controllerFile: filePath,
          controllerName: classMatch?.[1] ?? 'UnknownController',
          httpMethodCount: httpDecorators.length,
        });
      }
      continue;
    }

    const httpDecorators = findHttpDecorators(content);

    for (const tool of rawTools) {
      const httpDec = nearestHttpDecorator(httpDecorators, tool.sourceIndex);
      const method: HttpMethod = httpDec?.method ?? 'GET';
      const subRoute = httpDec?.subRoute ?? '';

      const fullPath = buildPath(apiPrefix, controllerPath, subRoute);
      const pathParams = extractPathParams(fullPath);

      result.tools.push({
        name: tool.name,
        description: tool.description,
        method,
        path: fullPath,
        module: moduleMeta?.intent,
        controllerFile: filePath,
        pathParams,
        needsApproval: tool.needsApproval,
        allowedRoles: tool.allowedRoles,
      });
    }
  }

  return result;
}
