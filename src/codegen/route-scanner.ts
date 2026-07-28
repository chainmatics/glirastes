import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { findRouteFiles, isDirAiIgnored, readFileSafe } from './fs-utils.js';
import type { EndpointMethod } from '../types.js';
import type { ToolRiskClass } from '../contracts/index.js';

export interface ScannedQueryParameter {
  name: string;
  repeated: boolean;
}

export interface ScannedSchemaBinding {
  symbol: string;
  module: string;
}

export interface ScannedRouteCandidate {
  sourceFile: string;
  sourceFingerprint: string;
  exportName: EndpointMethod;
  method: EndpointMethod;
  path: string;
  pathParams: string[];
  queryParams: ScannedQueryParameter[];
  schemaBindings: ScannedSchemaBinding[];
  authEvidence: string[];
  externalCallEvidence: string[];
  riskClass: ToolRiskClass;
  autoApprovalEligible: false;
  reviewReasons: string[];
}

export interface NextAppRouteScanResult {
  candidates: ScannedRouteCandidate[];
  ignored: string[];
}

export interface ScanNextAppRoutesOptions {
  rootDir: string;
  apiDir?: string;
}

export interface WriteNextAppRouteScanOptions
  extends ScanNextAppRoutesOptions {
  outputPath?: string;
  now?: () => Date;
}

const HTTP_METHODS = new Set<EndpointMethod>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const AUTH_PATTERNS: Array<[string, RegExp]> = [
  ['resolvePrincipal', /\bresolvePrincipal\s*\(/],
  ['resolveUser', /\bresolveUser\s*\(/],
  ['getServerSession', /\bgetServerSession\s*\(/],
  ['getSession', /\bgetSession\s*\(/],
  ['auth', /\bauth\s*\(/],
];

const EXTERNAL_PATTERNS: Array<[string, RegExp]> = [
  ['fetch', /\bfetch\s*\(/],
  ['dynamic-code', /\b(?:eval|Function)\s*\(/],
  ['child-process', /\b(?:exec|execFile|spawn)\s*\(/],
];

function sourceFingerprint(
  source: string,
  method: EndpointMethod,
  path: string,
): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const hash = createHash('sha256')
    .update(`${method}\n${path}\n${normalized}`)
    .digest('base64url');
  return `sha256:${hash}`;
}

function toSourceFile(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).split(sep).join('/');
}

function toRoutePath(
  apiDir: string,
  routeFile: string,
): { path: string; pathParams: string[] } {
  const routeDirectory = relative(apiDir, dirname(routeFile));
  const pathParams: string[] = [];
  const segments = routeDirectory
    .split(sep)
    .filter((segment) => segment && !/^\(.+\)$/.test(segment))
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) {
        pathParams.push(optionalCatchAll[1]);
        return `*${optionalCatchAll[1]}`;
      }
      const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) {
        pathParams.push(catchAll[1]);
        return `*${catchAll[1]}`;
      }
      const dynamic = segment.match(/^\[(.+)\]$/);
      if (dynamic) {
        pathParams.push(dynamic[1]);
        return `:${dynamic[1]}`;
      }
      return segment;
    });
  return {
    path: `/api${segments.length ? `/${segments.join('/')}` : ''}`,
    pathParams,
  };
}

function findMatchingDelimiter(
  source: string,
  startIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: '"' | '\'' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === '\'' || character === '`') {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function extractFunctionBody(source: string, startIndex: number): string {
  const parametersStart = source.indexOf('(', startIndex);
  if (parametersStart < 0) return '';
  const parametersEnd = findMatchingDelimiter(
    source,
    parametersStart,
    '(',
    ')',
  );
  if (parametersEnd < 0) return '';
  const bodyStart = source.indexOf('{', parametersEnd + 1);
  if (bodyStart < 0) return '';
  const bodyEnd = findMatchingDelimiter(source, bodyStart, '{', '}');
  return source.slice(
    bodyStart + 1,
    bodyEnd < 0 ? source.length : bodyEnd,
  );
}

function extractQueryParams(body: string): ScannedQueryParameter[] {
  const params = new Map<string, boolean>();
  for (const match of body.matchAll(
    /\bsearchParams\.(getAll|get)\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  )) {
    const name = match[2];
    const repeated = match[1] === 'getAll';
    params.set(name, repeated || (params.get(name) ?? false));
  }
  return [...params]
    .map(([name, repeated]) => ({ name, repeated }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function importBindings(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*['"`]([^'"`]+)['"`]/g,
  )) {
    for (const item of match[1].split(',')) {
      const [imported, local = imported] = item.trim().split(/\s+as\s+/);
      if (local) imports.set(local.trim(), match[2]);
    }
  }
  return imports;
}

function extractSchemaBindings(
  body: string,
  imports: Map<string, string>,
): ScannedSchemaBinding[] {
  const bindings = new Map<string, string>();
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\.safeParse\s*\(/g)) {
    const symbol = match[1];
    const module = imports.get(symbol);
    if (module) bindings.set(symbol, module);
  }
  return [...bindings]
    .map(([symbol, module]) => ({ symbol, module }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function evidence(
  source: string,
  patterns: Array<[string, RegExp]>,
): string[] {
  return patterns
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name);
}

function reviewReasons(options: {
  method: EndpointMethod;
  authEvidence: string[];
  externalCallEvidence: string[];
}): string[] {
  const reasons: string[] = [];
  if (options.authEvidence.length === 0) {
    reasons.push('auth-boundary-unverified');
  }
  if (options.externalCallEvidence.length > 0) {
    reasons.push('external-call-detected');
  }
  if (options.method === 'GET') {
    reasons.push('data-classification-unverified');
  } else if (options.method === 'DELETE') {
    reasons.push('delete-operation');
  } else {
    reasons.push('write-operation');
  }
  return reasons;
}

export async function scanNextAppRoutes(
  options: ScanNextAppRoutesOptions,
): Promise<NextAppRouteScanResult> {
  const apiDir = join(options.rootDir, options.apiDir ?? 'src/app/api');
  const candidates: ScannedRouteCandidate[] = [];
  const ignored: string[] = [];

  for (const routeFile of await findRouteFiles(apiDir)) {
    const source = await readFileSafe(routeFile);
    const sourceFile = toSourceFile(options.rootDir, routeFile);
    if (
      source.includes('@ai-ignore')
      || await isDirAiIgnored(dirname(routeFile))
    ) {
      ignored.push(sourceFile);
      continue;
    }

    const imports = importBindings(source);
    const route = toRoutePath(apiDir, routeFile);
    const methodPattern =
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

    for (const match of source.matchAll(methodPattern)) {
      const method = match[1] as EndpointMethod;
      if (!HTTP_METHODS.has(method)) continue;
      const body = extractFunctionBody(source, match.index);
      const authEvidence = evidence(body, AUTH_PATTERNS);
      const externalCallEvidence = evidence(body, EXTERNAL_PATTERNS);
      candidates.push({
        sourceFile,
        sourceFingerprint: sourceFingerprint(source, method, route.path),
        exportName: method,
        method,
        path: route.path,
        pathParams: route.pathParams,
        queryParams: extractQueryParams(body),
        schemaBindings: extractSchemaBindings(body, imports),
        authEvidence,
        externalCallEvidence,
        riskClass:
          method === 'DELETE'
            ? 'delete'
            : method === 'GET'
              ? 'unknown'
              : 'write',
        autoApprovalEligible: false,
        reviewReasons: reviewReasons({
          method,
          authEvidence,
          externalCallEvidence,
        }),
      });
    }
  }

  return { candidates, ignored };
}

export async function writeNextAppRouteScan(
  options: WriteNextAppRouteScanOptions,
): Promise<{
  outputPath: string;
  result: NextAppRouteScanResult;
}> {
  const result = await scanNextAppRoutes(options);
  const outputPath = resolve(
    options.rootDir,
    options.outputPath ?? '.glirastes/route-scan.json',
  );
  const artifact = {
    schemaVersion: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    ...result,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  return { outputPath, result };
}
