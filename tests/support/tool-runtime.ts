import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { FoundationExecutionInventorySchema } from '../../src/codegen/execution-inventory.js';
import type { Principal } from '../../src/contracts/index.js';
import { createAiSdkTools, type AiSdkWrappedTool } from '../../src/runtime/ai-sdk/index.js';
import {
  createGeneratedRuntimeSource,
  type GeneratedToolModule,
} from '../../src/runtime/contract-bindings.js';
import {
  createManagedTurnGuard,
  materializeManifestToolRegistry,
  type ManagedTurnGuard,
} from '../../src/runtime/index.js';
import {
  createHttpEndpointCaller,
  toolsToAiTools,
  type InternalApiRequest,
  type InternalApiResponse,
} from '../../src/server/index.js';
import type { ToolRegistry } from '../../src/types.js';

// Path arithmetic instead of `new URL(relative, import.meta.url)`: under jsdom that URL is http://localhost.
const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = resolve(HERE, '../..');
export const EXAMPLES = resolve(SDK_ROOT, 'examples/source-driven-next');
export const NATIVE_APP = join(EXAMPLES, 'native');
export const FIXTURE_TENANT_ID = '019fb007-0000-7000-8000-000000000002';
export const GENERATED_MODULE = 'src/generated/glirastes/tools.generated.js';
export const LOCAL_LIMITS = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

const copies: string[] = [];

/** The generated module imports glirastes/runtime and glirastes/server from dist. */
export function assertBuiltSdk(): void {
  for (const file of ['dist/runtime/index.js', 'dist/server/index.js']) {
    if (!existsSync(join(SDK_ROOT, file))) throw new Error(`Run bun run build first: ${file} is missing.`);
  }
}

/** Copies an app next to the fixture (so `zod` resolves) and links the local SDK as `glirastes`. */
export async function copyApp(from: string, prefix = '.tool-sync-'): Promise<string> {
  const root = await mkdtemp(join(EXAMPLES, prefix));
  copies.push(root);
  await cp(from, root, { recursive: true, filter: (source) => !source.split(sep).includes('node_modules') });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(SDK_ROOT, join(root, 'node_modules/glirastes'), 'dir');
  return root;
}

/**
 * Runs the built `glirastes tools refresh` on an app, like its `dev` script.
 * Use it from jsdom tests: the in-process pipeline spawns its schema probe
 * from `import.meta.url`, which jsdom rewrites to an http URL.
 */
export async function refreshWithCli(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath,
    [join(SDK_ROOT, 'dist/cli/bin.js'), 'tools', 'refresh', '--root', root],
    { env: { PATH: process.env.PATH ?? '' } });
  return stdout;
}

export async function removeCopiedApps(): Promise<void> {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
}

export function principal(roles: string[] = ['member'], subjectId = 'alice'): Principal {
  return { subjectId, tenantId: FIXTURE_TENANT_ID, roles, attributes: {} };
}

interface FixtureAuth {
  createSession(user: Principal): string;
  revokeSession(token: string): void;
  resolveSession(request: Request): Principal | undefined;
}

type RouteHandler = (request: Request) => Promise<Response>;

export interface BootedTurn {
  guard: ManagedTurnGuard;
  registry: ToolRegistry;
  tools: Record<string, AiSdkWrappedTool>;
  execute(name: string, input: unknown): Promise<unknown>;
}

export interface BootedApp {
  disabled: ReadonlyArray<{ toolId: string; reason: string }>;
  createSession(user: Principal): string;
  revokeSession(token: string): void;
  turn(options: { cookie?: string; authorization?: string; resolvePrincipal?: () => Principal | undefined }): BootedTurn;
}

function matchesRoute(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length
    && expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
}

type EndpointCaller = (request: InternalApiRequest) => Promise<InternalApiResponse>;

function runtimeOf(generated: GeneratedToolModule) {
  return createGeneratedRuntimeSource(generated, {
    localLimits: LOCAL_LIMITS,
    identity: { tenantId: FIXTURE_TENANT_ID },
  });
}

/** One managed turn per call, its endpoint tools calling the app with the turn's credentials. */
function turnsOf(
  runtime: ReturnType<typeof runtimeOf>,
  auth: FixtureAuth,
  endpointFor: (headers: Headers) => EndpointCaller,
): BootedApp['turn'] {
  return (options) => {
    const headers = new Headers({
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    });
    const resolvePrincipal = options.resolvePrincipal
      ?? (() => auth.resolveSession(new Request('http://fixture.local/chat', { headers })));
    const initial = resolvePrincipal();
    if (!initial) throw new Error('missing_principal');
    const snapshot = runtime.source.resolveTurnSnapshot({ turnId: randomUUID(), principal: initial });
    const guard = createManagedTurnGuard({ snapshot, resolvePrincipal });
    const registry = materializeManifestToolRegistry({ snapshot, bindings: runtime.bindings });
    const context = { currentDate: new Date(), locale: 'en-US', callEndpoint: endpointFor(headers) };
    const tools = createAiSdkTools({ tools: toolsToAiTools(registry, context), ...guard });
    return {
      guard,
      registry,
      tools,
      async execute(name, input) {
        const tool = tools[name];
        if (!tool?.execute) {
          await guard.beforeToolCall({ toolName: name, input });
          throw new Error(`Tool unavailable: ${name}`);
        }
        const parsed = registry[name]!.inputSchema.safeParse(input);
        if (!parsed.success) throw new Error(`Input does not match the bound schema (${name})`);
        return tool.execute(parsed.data, { toolCallId: randomUUID(), messages: [] });
      },
    };
  };
}

/** Boots the standalone runtime from the committed outputs, like the app's chat route does. */
export async function bootApp(root: string, modulePath = GENERATED_MODULE): Promise<BootedApp> {
  const generated = await import(pathToFileURL(join(root, modulePath)).href) as GeneratedToolModule;
  const runtime = runtimeOf(generated);
  const auth = await import(pathToFileURL(join(root, 'src/auth.js')).href) as FixtureAuth;
  const inventory = FoundationExecutionInventorySchema.parse(JSON.parse(
    await readFile(join(root, '.glirastes/foundation-execution-inventory.json'), 'utf8'),
  ));
  const routeModules = new Map<string, Record<string, RouteHandler | undefined>>();
  const handlerFor = async (method: string, pathname: string): Promise<RouteHandler | undefined> => {
    for (const execution of inventory.executions) {
      if (execution.executionKind !== 'endpoint' || execution.method !== method) continue;
      if (!matchesRoute(execution.path, pathname)) continue;
      let module = routeModules.get(execution.sourceFile);
      if (!module) {
        module = await import(pathToFileURL(join(root, execution.sourceFile)).href) as Record<string, RouteHandler | undefined>;
        routeModules.set(execution.sourceFile, module);
      }
      return module[method];
    }
    return undefined;
  };
  const endpointFor = (credentials: Headers): EndpointCaller => async ({ method, path, body }) => {
    const url = new URL(path, 'http://fixture.local');
    const handler = await handlerFor(method, url.pathname);
    if (!handler) return { ok: false, status: 404, error: 'Unavailable' };
    const headers = new Headers(credentials);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await handler(new Request(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    const data = await response.json() as unknown;
    const error = !response.ok && typeof data === 'object' && data !== null
      && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : undefined;
    return { ok: response.ok, status: response.status, data, ...(error ? { error } : {}) };
  };
  return {
    disabled: runtime.disabled,
    createSession: (user) => auth.createSession(user),
    revokeSession: (token) => { auth.revokeSession(token); },
    turn: turnsOf(runtime, auth, endpointFor),
  };
}

export const NEST_APP = resolve(SDK_ROOT, 'examples/react-nest-separate');
export const NEST_GENERATED_MODULE = 'api/src/generated/glirastes/tools.generated.ts';

/** The API's server adapter is a fixture-local dependency (examples/react-nest-separate/api/bun.lock). */
export function assertNestInstalled(): void {
  if (!existsSync(join(NEST_APP, 'api/node_modules/@nestjs/platform-express/package.json'))) {
    throw new Error('Run bun install --frozen-lockfile in examples/react-nest-separate/api first.');
  }
}

/** Copies the React+NestJS fixture like `copyApp` and links its installed API dependencies. */
export async function copyNestApp(from: string, prefix = '.tool-sync-nest-'): Promise<string> {
  const root = await copyApp(from, prefix);
  await symlink(join(NEST_APP, 'api/node_modules'), join(root, 'api/node_modules'), 'dir');
  return root;
}

interface NestApi {
  listen(port: number, host: string): Promise<unknown>;
  getUrl(): Promise<string>;
  close(): Promise<void>;
}

export interface BootedNestApp extends BootedApp {
  /** The API's own origin, e.g. `http://127.0.0.1:54321`. */
  origin: string;
}

const servers: NestApi[] = [];

/**
 * Compiles the API with its own tsconfig (NodeNext), starts it on a free
 * local port and boots the runtime from the compiled generated module. Tools
 * reach the API only over HTTP, through `createHttpEndpointCaller`.
 */
export async function bootNestApp(root: string, model: () => unknown = () => {
  throw new Error('This test sends no chat message');
}): Promise<BootedNestApp> {
  await promisify(execFile)(process.execPath, [join(SDK_ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'api')]);
  const dist = (file: string) => pathToFileURL(join(root, 'api/dist', file)).href;
  const generated = await import(dist('generated/glirastes/tools.generated.js')) as GeneratedToolModule;
  const runtime = runtimeOf(generated);
  const auth = await import(dist('auth/sessions.js')) as FixtureAuth;
  const { createApi } = await import(dist('app.js')) as {
    createApi(options: { model: () => unknown; apiOrigin: () => string; tenantId: string }): Promise<NestApi>;
  };
  let origin = '';
  const api = await createApi({ model, apiOrigin: () => origin, tenantId: FIXTURE_TENANT_ID });
  servers.push(api);
  await api.listen(0, '127.0.0.1');
  origin = await api.getUrl();
  return {
    origin,
    disabled: runtime.disabled,
    createSession: (user) => auth.createSession(user),
    revokeSession: (token) => { auth.revokeSession(token); },
    turn: turnsOf(runtime, auth, (headers) => createHttpEndpointCaller({
      baseUrl: origin,
      request: new Request(`${origin}/api/chat`, { headers }),
    })),
  };
}

export async function closeNestApps(): Promise<void> {
  for (const api of servers.splice(0)) await api.close();
}

export const VUE_APP = resolve(SDK_ROOT, 'examples/vue-fastapi');
export const VUE_GENERATED_MODULE = '.glirastes/build/tools.generated.mjs';
/** Python 3.12 with examples/vue-fastapi/api/requirements.txt installed. */
export const PYTHON = process.env.GLIRASTES_TEST_PYTHON ?? 'python3';

/**
 * True when PYTHON imports FastAPI, uvicorn and Pydantic; the Vue+FastAPI
 * tests skip visibly otherwise. The fixture's own CI job sets
 * GLIRASTES_REQUIRE_PYTHON=1, so there a missing Python fails instead of skipping.
 */
export function pythonReady(): boolean {
  const ready = spawnSync(PYTHON, ['-I', '-c', 'import fastapi, uvicorn, pydantic'], { stdio: 'ignore' }).status === 0;
  if (!ready && process.env.GLIRASTES_REQUIRE_PYTHON === '1') {
    throw new Error(`GLIRASTES_REQUIRE_PYTHON=1, but ${PYTHON} cannot import fastapi, uvicorn and pydantic; install examples/vue-fastapi/api/requirements.txt.`);
  }
  return ready;
}

/** The app's own export step (`python3 export_openapi.py`), which imports the app; Glirastes never does. */
export async function exportOpenapi(root: string): Promise<void> {
  await promisify(execFile)(PYTHON, ['-B', 'export_openapi.py'], {
    cwd: join(root, 'api'),
    env: { PATH: process.env.PATH ?? '' },
  });
}

export interface BootedFastapiApp {
  /** The FastAPI app's own origin, e.g. `http://127.0.0.1:54321`. */
  apiOrigin: string;
  /** The Node chat runtime next to it (runtime/chat.mjs). */
  runtimeOrigin: string;
  disabled: BootedApp['disabled'];
  /** Alice's session, accepted by the API as the `session` cookie or a bearer token. */
  token: string;
  turn: BootedApp['turn'];
}

const pythonProcesses: ChildProcess[] = [];
const chatRuntimes: Server[] = [];

function startUvicorn(root: string, sessions: Readonly<Record<string, Principal>>): Promise<string> {
  const child = spawn(PYTHON, [
    '-I', '-B', '-m', 'uvicorn', '--app-dir', join(root, 'api'), 'app.main:app', '--host', '127.0.0.1', '--port', '0',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH ?? '', FIXTURE_SESSIONS: JSON.stringify(sessions) },
  });
  pythonProcesses.push(child);
  return new Promise((started, failed) => {
    let log = '';
    const timer = setTimeout(() => failed(new Error(`uvicorn did not start within 20 s:\n${log}`)), 20_000);
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      log += chunk;
      const origin = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1];
      if (origin) {
        clearTimeout(timer);
        started(origin);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      failed(new Error(`uvicorn exited with ${String(code)}:\n${log}`));
    });
  });
}

/**
 * Starts the FastAPI app with uvicorn on a free local port, with one session
 * for Alice, and the Node chat runtime next to it. Endpoint tools reach the
 * API only over HTTP, through `createHttpEndpointCaller`.
 */
export async function bootFastapiApp(root: string, model: () => unknown = () => {
  throw new Error('This test sends no chat message');
}): Promise<BootedFastapiApp> {
  const token = randomUUID();
  const apiOrigin = await startUvicorn(root, { [token]: principal() });
  const generated = await import(pathToFileURL(join(root, VUE_GENERATED_MODULE)).href) as GeneratedToolModule;
  const runtime = runtimeOf(generated);
  const { createChatRuntime } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href) as {
    createChatRuntime(options: { apiOrigin: () => string; model: () => unknown; tenantId: string }): { server: Server };
  };
  const chat = createChatRuntime({ apiOrigin: () => apiOrigin, model, tenantId: FIXTURE_TENANT_ID });
  chatRuntimes.push(chat.server);
  await new Promise<void>((listening) => chat.server.listen(0, '127.0.0.1', listening));
  // The turn snapshot needs a principal before the first call; the API checks the same token on every call.
  const tokenOf = (request: Request) => request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
    ?? request.headers.get('cookie')?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const auth: FixtureAuth = {
    createSession: () => token,
    revokeSession: () => undefined,
    resolveSession: (request) => (tokenOf(request) === token ? principal() : undefined),
  };
  return {
    apiOrigin,
    runtimeOrigin: `http://127.0.0.1:${(chat.server.address() as AddressInfo).port}`,
    disabled: runtime.disabled,
    token,
    turn: turnsOf(runtime, auth, (headers) => createHttpEndpointCaller({
      baseUrl: apiOrigin,
      request: new Request(`${apiOrigin}/api/chat`, { headers }),
    })),
  };
}

export async function closeFastapiApps(): Promise<void> {
  for (const server of chatRuntimes.splice(0)) {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
  for (const child of pythonProcesses.splice(0)) {
    if (child.exitCode !== null) continue;
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await exited;
  }
}
