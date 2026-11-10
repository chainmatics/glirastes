import { mkdir, writeFile, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { findRouteFiles, isDirAiIgnored, readFileSafe } from './fs-utils.js';
import {
  discoverFoundationExecutions,
  type DiscoveredFoundationExecution,
  type FoundationExecutionInventory,
} from './execution-inventory.js';
import { createRouteSourceFingerprint } from './route-fingerprint.js';
import { readRouteExports, type RouteExportFinding } from './route-exports.js';
import type { EndpointMethod } from '../types.js';
import type { ToolRiskClass } from '../contracts/index.js';

export { createRouteSourceFingerprint } from './route-fingerprint.js';

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
  findings?: Array<RouteExportFinding & { sourceFile: string }>;
  executions?: DiscoveredFoundationExecution[];
  inventoryDigest?: string;
}

export interface ScanNextAppRoutesOptions {
  rootDir: string;
  apiDir?: string;
  mode?: 'legacy-route-scan' | 'foundation-inventory' | 'source-discovery';
  inventory?: FoundationExecutionInventory;
}

export interface WriteNextAppRouteScanOptions
  extends ScanNextAppRoutesOptions {
  outputPath?: string;
  now?: () => Date;
}

export const AUTH_PATTERNS: Array<[string, RegExp]> = [
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

function toSourceFile(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).split(sep).join('/');
}

export function toRoutePath(
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
  if (options.method === 'GET' || options.method === 'HEAD') {
    reasons.push('data-classification-unverified');
  } else if (options.method === 'DELETE') {
    reasons.push('delete-operation');
  } else {
    reasons.push('write-operation');
  }
  return reasons;
}

async function scanRouteCandidates(
  options: ScanNextAppRoutesOptions,
  respectLegacyIgnores: boolean,
  strictSources?: Map<string, string>,
): Promise<NextAppRouteScanResult> {
  const apiDir = join(options.rootDir, options.apiDir ?? 'src/app/api');
  const candidates: ScannedRouteCandidate[] = [];
  const ignored: string[] = [];
  const findings: NonNullable<NextAppRouteScanResult['findings']> = [];

  for (const routeFile of strictSources ? [...strictSources.keys()].sort() : await findRouteFiles(apiDir)) {
    const source = strictSources ? strictSources.get(routeFile)! : await readFileSafe(routeFile);
    const sourceFile = toSourceFile(options.rootDir, routeFile);
    if (
      respectLegacyIgnores
      && (
        source.includes('@ai-ignore')
        || await isDirAiIgnored(dirname(routeFile))
      )
    ) {
      ignored.push(sourceFile);
      continue;
    }

    const imports = importBindings(source);
    const route = toRoutePath(apiDir, routeFile);
    const parsed = readRouteExports(source, sourceFile);
    // HEAD is a tool only for the tools generator (source discovery); the
    // legacy scan upload keeps its five-method contract with the Platform.
    const included = (method: EndpointMethod | undefined) => Boolean(strictSources) || method !== 'HEAD';
    findings.push(...parsed.findings
      .filter((finding) => included(finding.exportName))
      .map((finding) => ({ sourceFile, ...finding })));
    for (const { method, body } of parsed.exports.filter((entry) => included(entry.method))) {
      const authEvidence = evidence(body, AUTH_PATTERNS);
      const externalCallEvidence = evidence(body, EXTERNAL_PATTERNS);
      candidates.push({
        sourceFile,
        sourceFingerprint: createRouteSourceFingerprint(
          source,
          method,
          route.path,
        ),
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
            : method === 'GET' || method === 'HEAD'
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

  return { candidates, ignored, ...(findings.length ? { findings } : {}) };
}

export async function scanNextAppRoutes(
  options: ScanNextAppRoutesOptions,
): Promise<NextAppRouteScanResult> {
  if (options.mode === 'source-discovery') {
    const inputRoot = resolve(options.rootDir);
    const rootDir = await realpath(options.rootDir);
    const relativeApi = relative(inputRoot, resolve(inputRoot, options.apiDir ?? 'src/app/api'));
    if (relativeApi.startsWith(`..${sep}`) || relativeApi === '..') throw new Error('Source directory must remain inside the app');
    const apiDir = resolve(rootDir, relativeApi);
    const sources = new Map<string, string>();
    let visited = 0;
    const walk = async (directory: string): Promise<void> => {
      if (++visited > 10_000 || await realpath(directory) !== directory) throw new Error('Source discovery is incomplete');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (entry.isDirectory() && entry.name.startsWith('_')) continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Source discovery is incomplete');
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile() || !/^route\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
        if (sources.size >= 5_000 || await realpath(path) !== path || (await stat(path)).size > 2_000_000) {
          throw new Error('Source discovery is incomplete');
        }
        sources.set(path, await readFile(path, 'utf8'));
      }
    };
    await walk(apiDir);
    return scanRouteCandidates({ ...options, rootDir, apiDir: relativeApi }, false, sources);
  }
  if ((options.mode ?? 'legacy-route-scan') === 'legacy-route-scan') {
    return scanRouteCandidates(options, true);
  }
  if (!options.inventory) {
    throw new Error('Foundation inventory mode requires an execution inventory');
  }

  const discovery = await discoverFoundationExecutions({
    rootDir: options.rootDir,
    inventory: options.inventory,
  });
  const scanned = await scanRouteCandidates(options, false);
  const endpointKeys = new Set(discovery.executions
    .filter((execution) => execution.executionKind === 'endpoint')
    .map((execution) => execution.stableKey));

  return {
    candidates: scanned.candidates.filter((candidate) => (
      endpointKeys.has(`${candidate.method} ${candidate.path}`)
    )),
    ignored: [],
    executions: discovery.executions,
    inventoryDigest: discovery.inventoryDigest,
    ...(scanned.findings ? { findings: scanned.findings } : {}),
  };
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
