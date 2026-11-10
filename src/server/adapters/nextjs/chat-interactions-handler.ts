import { randomUUID } from 'node:crypto';
import {
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatEntityData,
  type ChatInteractionsData,
} from '../../../contracts/chat-interactions.js';
import { PrincipalSchema } from '../../../contracts/index.js';
import { authorizeToolCall } from '../../../runtime/authorization.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import { isToolRevoked, type TurnSnapshot } from '../../../runtime/turn-snapshot.js';
import type { ManagedLocalRuntimeConfig } from './types.js';

export interface ChatInteractionsHandlerConfig {
  /** `chatInteractions` of the generated module. */
  interactions: ChatInteractionsData;
  /** Parsed `.glirastes/chat-interactions.json`; validated at creation. */
  overrides?: unknown;
  /**
   * The chat handler's managed runtime. With it, the response is per user:
   * commands, actions and searches whose tool this user may not run (Platform
   * disabled, roles, revocation, not deployed) are left out.
   */
  managedRuntime?: ManagedLocalRuntimeConfig;
}

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/**
 * GET handler that serves the chat's `@` entities and `/` commands to the
 * browser (`useChatInteractionsData`, `<glirastes-chat interactions>`).
 * Overrides are applied once at creation; an invalid override file throws
 * there, like an invalid policy. Nothing is sent to the Glirastes Platform.
 *
 * ```ts
 * import overrides from '../../../.glirastes/chat-interactions.json' with { type: 'json' };
 * export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime });
 * ```
 */
export function createChatInteractionsHandler(config: ChatInteractionsHandlerConfig) {
  const merged = mergeChatInteractions(
    parseChatInteractions(config.interactions),
    config.overrides === undefined ? undefined : parseChatInteractionOverrides(config.overrides),
  );

  return async function chatInteractionsHandler(request: Request): Promise<Response> {
    const runtime = config.managedRuntime;
    if (!runtime) return json(merged);
    const principal = PrincipalSchema.safeParse(await runtime.resolvePrincipal(request));
    if (!principal.success) return json({ error: 'Unauthorized' }, 401);
    let snapshot: TurnSnapshot;
    try {
      snapshot = await runtime.resolveTurnSnapshot({
        request, turnId: `interactions-${randomUUID()}`, principal: principal.data,
      });
    } catch {
      return json({ error: 'Chat interactions unavailable' }, 503);
    }
    const revocations = await runtime.loadRevocations?.({ request, snapshot }) ?? [];
    const allowed = (tool: string): boolean => {
      const manifestTool = snapshot.manifestRevision.tools.find((candidate) => (
        candidate.name === tool || modelFacingToolName(candidate.name) === modelFacingToolName(tool)
      ));
      if (!manifestTool || isToolRevoked(snapshot, manifestTool.toolId, revocations)) return false;
      return authorizeToolCall({
        principal: principal.data,
        agentRevision: snapshot.agentRevision,
        manifestRevision: snapshot.manifestRevision,
        policyRevision: snapshot.policyRevision,
        toolId: manifestTool.toolId,
      }).allowed;
    };
    const entities = merged.entities.flatMap((entity): ChatEntityData[] => {
      const actions = (entity.actions ?? []).filter((action) => allowed(action.run.tool));
      const search = entity.search && allowed(entity.search.tool) ? entity.search : undefined;
      if (!search && actions.length === 0) return [];
      const { search: _search, actions: _actions, ...rest } = entity;
      return [{ ...rest, ...(search ? { search } : {}), ...(actions.length > 0 ? { actions } : {}) }];
    });
    const commands = merged.commands.filter((command) => command.run.kind === 'prompt' || allowed(command.run.tool));
    return json({ schemaVersion: 1, entities, commands } satisfies ChatInteractionsData);
  };
}
