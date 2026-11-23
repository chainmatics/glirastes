import {
  PRIVACY_DECISION_CODES,
  type EffectivePrivacyPolicy,
  type LocalPrivacyPolicy,
  type PrivacyDecisionCode,
} from '../../contracts/privacy-policy.js';
import {
  attachmentDecision,
  constrainAttachmentPolicy,
  resolveAttachmentPolicy,
  type AttachmentPolicyInput,
  type AttachmentPolicySnapshot,
} from './attachment-policy.js';
import { isPrivacyError, PrivacyError, toSafeError, type PrivacyErrorCode } from './detection-result.js';
import { privacyStatusData, type PrivacyStatusData } from './display-projection.js';
import { bindNewInput, newInputTexts, protectedHistory, sealProtectedResponse, type ProtectedHistory } from './history-binding.js';
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
import type { PrivacyToolOptions, ToolReceiptStore } from './tool-boundary.js';
import type { ProviderPolicyConstraint, ProviderRegistry, ResolvedProvider } from './provider-registry.js';

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
   * choice, resolved to the most restrictive. Default: blocked. It only
   * narrows the effective policy: `allow-original` needs that mode in the
   * signed block or, without one, in `policy.screenshots`.
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
   * The local privacy policy. It may only tighten a signed Platform block.
   * `required` defaults to false. Only explicit `required: true` activates
   * self-managed pseudonymization without a signed protected policy.
   * Missing/false leaves the signed policy in charge (no block or `off`:
   * ordinary unprotected operation). Its
   * screenshot, provider and OpenRouter fields narrow a signed block.
   * Without a signed block they apply as merged: screenshots are blocked
   * unless `screenshots.mode` is `allow-original`, `providerEntryIds`
   * narrow the registry's offer and `openRouterOnly` the upstream
   * providers, exactly as the effective policy digest reports. The
   * `attachments` rule can only narrow that further.
   */
  policy?: LocalPrivacyPolicy;
  /**
   * Content-free decision counter for the `privacy.decisions` event: one
   * code per protected turn, model call, rehydrated tool call and stop.
   */
  onDecision?: (code: PrivacyDecisionCode) => void;
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

/**
 * The privacy policy of one turn, pinned at its start with the managed
 * snapshot. Without it the turn follows the local configuration alone.
 */
export interface ChatPrivacyTurnPolicy {
  /** `mergePrivacyPolicy` of the signed block and the local configuration. */
  effective: EffectivePrivacyPolicy;
  /**
   * Re-checks the pinned policy before every model call and tool execution;
   * throws a `PrivacyError` such as `privacy_policy_revoked`.
   */
  check?: () => void | Promise<void>;
  /** Content-free decision counter (`privacy.decisions`). */
  onDecision?: (code: PrivacyDecisionCode) => void;
}

export interface ChatPrivacyTurn {
  readonly session: PrivacySession;
  /** The effective policy of this turn, when one was given. */
  readonly policy: EffectivePrivacyPolicy | undefined;
  /** Options for `wrapToolsForPrivacy`: the policy check and the rehydration counter. */
  toolHooks(): Pick<PrivacyToolOptions, 'beforeExecute' | 'onRehydrated'>;
  /** Options for another boundary of this turn (the classifier): stops, policy check, counter, provider approval. */
  boundaryHooks(): Pick<PrivacyBoundaryOptions, 'onBlocked' | 'beforeModelCall' | 'onProtected' | 'approveModel'>;
  readonly attachments: AttachmentPolicySnapshot;
  readonly config: ChatPrivacyConfig;
  /** The provider resolved for this turn, when `providers` is configured. */
  readonly provider: ResolvedProvider | undefined;
  /** Refuses a file in the latest user message that the screenshot rule blocks, before any model call. */
  checkLatestMessage(message: unknown): void;
  /**
   * Selects the history the model may receive (see `history-binding.ts`) and
   * binds the new user message, which must already have passed the
   * protection path. Throws `privacy_mapping_expired` for a continuation of
   * a message that is not bound in this generation.
   */
  admitHistory(messages: ReadonlyArray<unknown>): Promise<unknown[]>;
  /** Binds this turn's answer as released to the response stream; other responses pass unchanged. */
  sealResponse(response: Response): Response;
  /** Builds the boundary for the model resolved for this turn and checks the latest message's files against it. */
  bind(model: unknown, latestMessage: unknown): { boundary: PrivacyBoundary; model: unknown; status: PrivacyStatusData };
}

const STATUS: Partial<Record<PrivacyErrorCode, number>> = {
  privacy_scope_invalid: 400,
  privacy_attachment_blocked: 403,
  privacy_mapping_deleted: 409,
  privacy_mapping_expired: 409,
  privacy_mapping_conflict: 409,
  provider_capability_missing: 422,
  provider_not_allowed: 403,
  provider_unavailable: 503,
  privacy_not_configured: 503,
  privacy_policy_unavailable: 503,
  privacy_policy_revoked: 503,
  privacy_policy_downgrade: 503,
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
  policy?: ChatPrivacyTurnPolicy,
): Promise<ChatPrivacyTurn | null> {
  const decide = (code: string) => {
    if (!policy?.onDecision || !DECISION_CODES.has(code)) return;
    try {
      policy.onDecision(code as PrivacyDecisionCode);
    } catch {
      // A metrics sink never changes the decision.
    }
  };
  const onBlocked = (code: string) => {
    decide(code);
    config.onBlocked?.(code);
  };
  try {
    const turn = await openTurn(config, req, body, policy, decide, onBlocked);
    if (turn) decide('turn_protected');
    return turn;
  } catch (error) {
    decide(isPrivacyError(error) ? error.code : 'privacy_unsupported_content');
    throw error;
  }
}

const DECISION_CODES: ReadonlySet<string> = new Set(PRIVACY_DECISION_CODES);

async function openTurn(
  config: ChatPrivacyConfig,
  req: Request,
  body: { id?: unknown },
  policy: ChatPrivacyTurnPolicy | undefined,
  decide: (code: string) => void,
  onBlocked: (code: string) => void,
): Promise<ChatPrivacyTurn | null> {
  // Without a chat id every conversation would share one mapping: refuse.
  if (typeof body.id !== 'string' || body.id.length === 0) throw new PrivacyError('privacy_scope_invalid');
  const effective = policy?.effective;
  // The effective policy narrows attachments and providers, with or without
  // a signed block; only a signed block carries an approval list.
  const signed = effective?.source === 'platform' ? effective : undefined;
  // A signed approval list needs the registry's bindings: without a registry
  // nothing can show that the handler's model is an approved one.
  if (effective?.providers.allowed && !config.providers) throw new PrivacyError('privacy_not_configured');
  const conversationId = body.id;
  const scope = await config.scope(req, { conversationId });
  if (!scope) return null;
  await policy?.check?.();
  const session = await config.shield.open(scope, {
    signal: req.signal,
    ...(effective
      ? {
          lifetime: {
            idleTtlMs: effective.mapping.idleTtlSeconds * 1000,
            absoluteTtlMs: effective.mapping.absoluteTtlSeconds * 1000,
          },
        }
      : {}),
  });
  const identities = await config.knownIdentities?.(req, session.scope) ?? [];
  if (identities.length > 0) await session.registerIdentities(identities);
  const local = resolveAttachmentPolicy(await config.attachments?.(req, session.scope) ?? {});
  // The effective policy governs as merged, with or without a signed block:
  // what the reported digest says is what runs.
  const attachments = effective ? constrainAttachmentPolicy(local, effective.screenshots) : local;
  const constraint: ProviderPolicyConstraint | undefined = effective
    ? {
        ...effective.providers,
        ...(!signed && config.policy?.providerEntryIds ? { offeredEntryIds: [...config.policy.providerEntryIds] } : {}),
      }
    : undefined;
  const registry = config.providers?.registry;
  const provider = config.providers
    ? config.providers.registry.resolve(
        session.scope,
        await config.providers.selection?.(req, session.scope),
        constraint,
      )
    : undefined;
  // Every model of a turn with a signed approval list must be the one the
  // registry built under that approval; anything else is refused before a
  // request (the classifier's own model included).
  const approveModel = signed && registry && constraint
    ? (model: unknown) => {
        if (!registry.approves(model, constraint)) throw new PrivacyError('provider_not_allowed');
      }
    : undefined;
  const checkFiles = (message: unknown, visionCapable: boolean) => {
    for (const part of filePartsOf(message)) {
      const mediaType = typeof part.mediaType === 'string' ? part.mediaType : undefined;
      const decision = attachmentDecision({ mediaType, data: part.url }, attachments, visionCapable);
      if (!decision.allowed) throw new PrivacyError(decision.code);
    }
  };

  let admitted: (ProtectedHistory & { answerAnchor: string | null }) | undefined;
  const boundaryHooks = (): Pick<PrivacyBoundaryOptions, 'onBlocked' | 'beforeModelCall' | 'onProtected' | 'approveModel'> => ({
    onBlocked,
    ...(policy?.check ? { beforeModelCall: policy.check } : {}),
    onProtected: () => decide('model_call_protected'),
    ...(approveModel ? { approveModel } : {}),
  });

  return {
    session,
    policy: effective,
    toolHooks: () => ({
      ...(policy?.check ? { beforeExecute: policy.check } : {}),
      onRehydrated: () => decide('tool_call_rehydrated'),
    }),
    boundaryHooks,
    attachments,
    config,
    provider,
    checkLatestMessage: (message) => checkFiles(message, true),
    async admitHistory(messages) {
      const history = protectedHistory(messages, session);
      // Every text of the new message passes detection, pseudonymization and
      // the pseudonym-collision check before it is bound as history.
      for (const text of newInputTexts(history)) await session.pseudonymizeText(text);
      admitted = { ...history, answerAnchor: await bindNewInput(session, history) };
      return history.messages;
    },
    sealResponse(response) {
      if (!admitted) return response;
      return sealProtectedResponse(response, session, {
        anchor: admitted.answerAnchor,
        ...(admitted.continued ? { continued: admitted.continued } : {}),
        onBindFailed: () => onBlocked('privacy_history_not_bound'),
      });
    },
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
        ...boundaryHooks(),
      });
      // A file in the message the user just sent is refused visibly instead
      // of being withheld silently; older files are withheld by the boundary.
      checkFiles(latestMessage, boundary.capabilities.images === true);
      const wrapped = boundary.wrapModel(model);
      const label = provider ? provider.label : config.providerLabel?.(model);
      return {
        boundary,
        model: wrapped,
        status: privacyStatusData(session, attachments, {
          ...(label ? { providerLabel: label } : {}),
          ...(admitted?.withheldMessages ? { historyWithheld: admitted.withheldMessages } : {}),
        }),
      };
    },
  };
}
