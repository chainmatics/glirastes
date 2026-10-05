import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  toolsToAiTools,
  type InternalApiRequest,
  type InternalApiResponse,
} from '../../src/server/index.js';
import type { ToolRegistry } from '../../src/types.js';

export const SDK_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXAMPLES = fileURLToPath(new URL('../../examples/source-driven-next/', import.meta.url));
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
  turn(options: { cookie?: string; resolvePrincipal?: () => Principal | undefined }): BootedTurn;
}

function matchesRoute(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length
    && expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
}

/** Boots the standalone runtime from the committed outputs, like the app's chat route does. */
export async function bootApp(root: string, modulePath = GENERATED_MODULE): Promise<BootedApp> {
  const generated = await import(pathToFileURL(join(root, modulePath)).href) as GeneratedToolModule;
  const runtime = createGeneratedRuntimeSource(generated, {
    localLimits: LOCAL_LIMITS,
    identity: { tenantId: FIXTURE_TENANT_ID },
  });
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
  return {
    disabled: runtime.disabled,
    createSession: (user) => auth.createSession(user),
    revokeSession: (token) => { auth.revokeSession(token); },
    turn(options) {
      const resolvePrincipal = options.resolvePrincipal ?? (() => auth.resolveSession(new Request(
        'http://fixture.local/chat',
        { headers: options.cookie ? { cookie: options.cookie } : {} },
      )));
      const initial = resolvePrincipal();
      if (!initial) throw new Error('missing_principal');
      const snapshot = runtime.source.resolveTurnSnapshot({ turnId: randomUUID(), principal: initial });
      const guard = createManagedTurnGuard({ snapshot, resolvePrincipal });
      const registry = materializeManifestToolRegistry({ snapshot, bindings: runtime.bindings });
      const callEndpoint = async ({ method, path, body }: InternalApiRequest): Promise<InternalApiResponse> => {
        const url = new URL(path, 'http://fixture.local');
        const handler = await handlerFor(method, url.pathname);
        if (!handler) return { ok: false, status: 404, error: 'Unavailable' };
        const headers = new Headers(options.cookie ? { cookie: options.cookie } : {});
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
      const context = { currentDate: new Date(), locale: 'en-US', callEndpoint };
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
    },
  };
}
