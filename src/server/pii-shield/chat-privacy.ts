import {
  attachmentDecision,
  resolveAttachmentPolicy,
  type AttachmentPolicyInput,
  type AttachmentPolicySnapshot,
} from './attachment-policy.js';
import { isPrivacyError, PrivacyError, toSafeError, type PrivacyErrorCode } from './detection-result.js';
import { privacyStatusData, type PrivacyStatusData } from './display-projection.js';
import type { KnownIdentity } from './known-identities.js';
import type { PrivacyScope } from './mapping-store.js';
import {
  createPrivacyBoundary,
  type ModelCapabilities,
  type PrivacyBoundary,
  type PrivacyBoundaryOptions,
  type ProviderOptionsAllowlist,
} from './model-boundary.js';
import type { PrivacySession, StrictPiiShield } from './strict-shield.js';
import type { ToolReceiptStore } from './tool-boundary.js';
import type { ProviderRegistry, ResolvedProvider } from './provider-registry.js';

/**
 * The protected-text profile of a chat handler. Every model call of a turn
 * (answer, tool steps, retries, classifier) goes through one boundary built
 * from the authenticated scope of the request; the browser gets the
 * originals back only through the display projection of that scope.
 */
export interface ChatPrivacyConfig {
  shield: StrictPiiShield;
  /**
   * The authenticated scope of this request. `conversationId` is the chat id
   * the client sent (`body.id`; a request without one is refused with 400
   * `privacy_scope_invalid` before this is called); tenant, app, environment
   * and principal must come from the server-side session. Return `null` to
   * refuse (401).
   */
  scope(req: Request, chat: { conversationId: string }): PrivacyScope | null | Promise<PrivacyScope | null>;
  /**
   * Identities the principal is authorized to see and that should be
   * protected deterministically: at least the signed-in user. Never load
   * unrelated people only for detection.
   */
  knownIdentities?(req: Request, scope: PrivacyScope): ReadonlyArray<KnownIdentity> | Promise<ReadonlyArray<KnownIdentity>>;
  /**
   * The screenshot rule of this turn: app ceiling, tenant rule and the user's
   * choice, resolved to the most restrictive. Default: blocked.
   */
  attachments?(req: Request, scope: PrivacyScope): AttachmentPolicyInput | Promise<AttachmentPolicyInput>;
  /** What the resolved model can receive. Default: text, tools, structured output; no images. */
  modelCapabilities?: ModelCapabilities | ((model: unknown) => ModelCapabilities | undefined);
  /** Display label of the resolved model for the status line (never an endpoint or key). */
  providerLabel?: (model: unknown) => string | undefined;
  providerOptions?: ProviderOptionsAllowlist;
  identitiesFromToolResults?: PrivacyBoundaryOptions['identitiesFromToolResults'];
  /** Durable receipts for idempotent tool writes (the runtime store). */
  receipts?: ToolReceiptStore;
  /** Content-free stop notices, e.g. for metrics. */
  onBlocked?: (code: string) => void;
  /**
   * Interchangeable providers. The turn resolves the user's choice once at
   * its start and uses that model instead of the handler's `model`; an
   * invalid choice stops the turn with `provider_not_allowed` (403), a
   * missing server secret with `provider_unavailable` (503).
   */
  providers?: {
    registry: ProviderRegistry;
    /** The entry id the user chose (e.g. from a server-side setting). Absent: the registry default. */
    selection?(req: Request, scope: PrivacyScope): string | null | undefined | Promise<string | null | undefined>;
  };
}

export interface ChatPrivacyTurn {
  readonly session: PrivacySession;
  readonly attachments: AttachmentPolicySnapshot;
  readonly config: ChatPrivacyConfig;
  /** The provider resolved for this turn, when `providers` is configured. */
  readonly provider: ResolvedProvider | undefined;
  /** Refuses a file in the latest user message that the screenshot rule blocks, before any model call. */
  checkLatestMessage(message: unknown): void;
  /** Builds the boundary for the model resolved for this turn and checks the latest message's files against it. */
  bind(model: unknown, latestMessage: unknown): { boundary: PrivacyBoundary; model: unknown; status: PrivacyStatusData };
}

const STATUS: Partial<Record<PrivacyErrorCode, number>> = {
  privacy_scope_invalid: 400,
  privacy_attachment_blocked: 403,
  privacy_mapping_deleted: 409,
  provider_capability_missing: 422,
  provider_not_allowed: 403,
  provider_unavailable: 503,
};

/** Content-free HTTP refusal of a protected turn. */
export function privacyRefusal(error: unknown): Response {
  const code = isPrivacyError(error) ? error.code : 'privacy_unsupported_content';
  return new Response(JSON.stringify({ error: code }), {
    status: STATUS[code] ?? 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * What error callbacks receive in the protected profile: name and code only.
 * Provider errors keep their numeric HTTP status, which carries no content.
 */
export function privacySafeError(error: unknown): Error & { code: string; statusCode?: number } {
  if (isPrivacyError(error)) return error;
  const summary = toSafeError(error);
  const safe = new Error(`${summary.name}: ${summary.code}`) as Error & { code: string; statusCode?: number };
  safe.name = summary.name;
  safe.code = summary.code;
  const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === 'number' && Number.isInteger(status)) safe.statusCode = status;
  // No stack: it would name the throwing frame's message again.
  safe.stack = undefined;
  return safe;
}

function filePartsOf(message: unknown): Array<{ mediaType?: unknown; url?: unknown }> {
  const parts = (message as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return [];
  return parts.filter((part) => (part as { type?: unknown } | null)?.type === 'file') as Array<{ mediaType?: unknown; url?: unknown }>;
}

/** Latest user message of a UI message list. */
export function latestUserMessage(messages: ReadonlyArray<unknown>): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown } | null)?.role === 'user') return messages[i];
  }
  return undefined;
}

/**
 * Opens the protected view of one turn. Throws a `PrivacyError` (or returns
 * `null` for an unauthenticated request); the caller answers with
 * {@link privacyRefusal}.
 */
export async function openChatPrivacyTurn(
  config: ChatPrivacyConfig,
  req: Request,
  body: { id?: unknown },
): Promise<ChatPrivacyTurn | null> {
  // Without a chat id every conversation would share one mapping: refuse.
  if (typeof body.id !== 'string' || body.id.length === 0) throw new PrivacyError('privacy_scope_invalid');
  const conversationId = body.id;
  const scope = await config.scope(req, { conversationId });
  if (!scope) return null;
  const session = await config.shield.open(scope, { signal: req.signal });
  const identities = await config.knownIdentities?.(req, session.scope) ?? [];
  if (identities.length > 0) await session.registerIdentities(identities);
  const attachments = resolveAttachmentPolicy(await config.attachments?.(req, session.scope) ?? {});
  const provider = config.providers
    ? config.providers.registry.resolve(session.scope, await config.providers.selection?.(req, session.scope))
    : undefined;

  const checkFiles = (message: unknown, visionCapable: boolean) => {
    for (const part of filePartsOf(message)) {
      const mediaType = typeof part.mediaType === 'string' ? part.mediaType : undefined;
      const decision = attachmentDecision({ mediaType, data: part.url }, attachments, visionCapable);
      if (!decision.allowed) throw new PrivacyError(decision.code);
    }
  };

  return {
    session,
    attachments,
    config,
    provider,
    checkLatestMessage: (message) => checkFiles(message, true),
    bind(handlerModel, latestMessage) {
      // A resolved provider replaces the handler's model for the whole turn.
      const model = provider ? provider.model : handlerModel;
      const capabilities = provider
        ? provider.capabilities
        : typeof config.modelCapabilities === 'function'
          ? config.modelCapabilities(model)
          : config.modelCapabilities;
      const boundary = createPrivacyBoundary({
        session,
        attachments,
        ...(capabilities ? { capabilities } : {}),
        ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
        ...(config.identitiesFromToolResults !== undefined ? { identitiesFromToolResults: config.identitiesFromToolResults } : {}),
        ...(config.onBlocked ? { onBlocked: config.onBlocked } : {}),
      });
      // A file in the message the user just sent is refused visibly instead
      // of being withheld silently; older files are withheld by the boundary.
      checkFiles(latestMessage, boundary.capabilities.images === true);
      const wrapped = boundary.wrapModel(model);
      const label = provider ? provider.label : config.providerLabel?.(model);
      return {
        boundary,
        model: wrapped,
        status: privacyStatusData(session, attachments, label ? { providerLabel: label } : {}),
      };
    },
  };
}
