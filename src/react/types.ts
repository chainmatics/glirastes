import type { EntityDeclarationsByTool } from '../contracts/entity-declaration.js';
import type { ApprovalPreviewFormat, ApprovalSubjectUncheckedReason } from '../contracts/approval-subject.js';
import type { ReactNode, ReactElement, ComponentType, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { UiActionBus } from '../browser/ui-action-bus.js';
import type { UiActionRunCode } from '../browser/client-actions.js';
import type { ClarificationRequest } from '../contracts/clarification.js';
import type { AnyToolResultRenderer } from './tool-renderers/registry.js';
import type { ChatInteractionsConfig, PendingChatCommand } from './interactions/registry.js';
import type { AttachmentBlobStore } from './utils/attachment-blob-store.js';
import type { ChatEntityLinksConfig } from './entity-links/entity-links.js';

export type {
  ClarificationOption,
  ClarificationRequest,
  ClarificationTarget,
} from '../contracts/clarification.js';

/** A value or a promise of it. @internal */
export type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Chat Transport — transport-agnostic interface for chat backends
// ============================================================================

/**
 * Data part emitted by the transport during streaming.
 * Used for pipeline reports, truncation, and custom data events.
 */
export interface ChatTransportDataPart {
  type: string;
  data: unknown;
}

/**
 * Callback that receives data parts from the transport during streaming.
 */
export type ChatTransportDataHandler = (dataPart: ChatTransportDataPart) => void;

/**
 * Approval response sent back to the transport.
 */
export interface ChatTransportApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

/**
 * The core transport interface that decouples AiChatProvider from any
 * specific streaming backend (Vercel AI SDK, SSE, WebSocket, LangGraph, etc.).
 *
 * Consumers provide a transport implementation to AiChatProvider via the
 * `transport` prop (required). Pick one of the bundled transports
 * (`useVercelAiChatTransport`, `useLangGraphChatTransport`) from their
 * dedicated subpaths, or implement this interface for a custom backend.
 *
 * @example
 * ```tsx
 * import { AiChatProvider } from 'glirastes/react';
 * import { useLangGraphChatTransport } from 'glirastes/react/langgraph';
 *
 * const transport = useLangGraphChatTransport({ endpoint: '/api/chat' });
 * <AiChatProvider transport={transport}>
 *   <MessageList />
 *   <ChatInput />
 * </AiChatProvider>
 * ```
 */
export interface ChatTransport {
  /** Current messages in the conversation */
  messages: ChatMessage[];
  /** Current transport status */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Current error, if any */
  error: Error | null;
  /** Send a user message; `files` only with a transport that supports attachments. */
  sendMessage(opts: { text: string; files?: FilePart[] }): Promise<void>;
  /** Stop the current generation */
  stop(): void;
  /** Replace the message list (for session restore, sanitization) */
  setMessages(messages: ChatMessage[]): void;
  /** Respond to a tool approval request */
  addToolApprovalResponse(response: ChatTransportApprovalResponse): void | PromiseLike<void>;
  /**
   * Subscribe to data parts emitted by the transport during streaming.
   * Returns an unsubscribe function. AiChatProvider calls this to wire
   * its internal pipeline/truncation handlers; consumers can also use it
   * for custom data-part processing.
   */
  subscribeToData?(handler: ChatTransportDataHandler): () => void;
  /**
   * Replaces the output of a tool call in the last message. With it the
   * provider reports UI outcomes (`outcome` in the tool result); the
   * transport then sends the history again once every result that waits for
   * an outcome (`awaitsOutcome: true`) has one, and says in every request
   * that it does so (`glirastesUiOutcomes: 1`). Without it the chat neither
   * reports nor resends, and the server answers as without the protocol.
   */
  addToolOutput?(output: { tool: string; toolCallId: string; output: unknown }): void | PromiseLike<void>;
  /** Sends the history again without a new message (a turn continued on a page the UI action loaded). */
  continueTurn?(): void | PromiseLike<void>;
  /** Called by the provider: whether it reports outcomes through this transport. */
  setUiOutcomeReporting?(enabled: boolean): void;
  /**
   * Called by the provider with the chat language to name in each request
   * (`Content-Language`), or null for none (`sendLanguage: false`, unknown).
   */
  setRequestLanguage?(language: string | null): void;
}

/**
 * Configuration for transports that connect to an HTTP endpoint.
 * Used by VercelAiChatTransport and can be used by custom transports.
 */
export interface ChatTransportConfig {
  /** The chat API endpoint URL */
  endpoint: string;
  /** Static headers or a function that returns headers per request */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Callback for streaming data parts (pipeline reports, truncation, etc.) */
  onData?: ChatTransportDataHandler;
}

// ============================================================================
// Speech / Voice Input
// ============================================================================

export interface UseDeepgramTranscriptionOptions {
  language?: string;
  baseUrl?: string;
  /** URL of the audio worklet file; default `/audio-worklet-processor.js`. */
  workletUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => MaybePromise<string | null | undefined>;
  /**
   * The app's own speech provider instead of the Deepgram stream, for example
   * a `RecordedSttAdapter`. `baseUrl` and `getToken` are then unused. Keep
   * one instance across renders; a new one ends the running recording.
   */
  adapter?: import('./stt/controller.js').SttProviderAdapter;
  onInterimTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

export interface UseDeepgramTranscriptionReturn {
  phase: import('./stt/controller.js').SttSessionPhase;
  isRecording: boolean;
  isConnecting: boolean;
  error: string | null;
  transcript: string;
  interimTranscript: string;
  displayTranscript: string;
  stream: MediaStream | null;
  startRecording: (previousDraft?: string) => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => Promise<string>;
  retry: () => Promise<void>;
}

export interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
  language?: string;
  baseUrl?: string;
  /** URL of the audio worklet file; default `/audio-worklet-processor.js`. */
  workletUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => MaybePromise<string | null | undefined>;
  onError?: (error: string) => void;
}

export interface RecordingBarProps {
  isConnecting: boolean;
  /** The existing authoritative recorder stream; never opens another mic. */
  stream?: MediaStream | null;
  /**
   * Live final plus interim transcript shown next to the waveform. It is
   * never written into the editor before Stop.
   */
  transcript?: string;
  onCancel: () => void;
  onStop: () => void;
  variant: 'trigger' | 'inline';
  className?: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  createdAt?: Date;
}

export type MessagePart =
  | TextPart
  | FilePart
  | ToolInvocationPart
  | ToolResultPart;

export interface TextPart {
  type: 'text';
  text: string;
}

/** An attached file. An empty `url` marks an attachment whose data was dropped (stored sessions). */
export interface FilePart {
  type: 'file';
  mediaType: string;
  /** A `data:` URL. */
  url: string;
  filename?: string;
  /** `glirastes.attachmentId` names the file for the model and the app. */
  providerMetadata?: { glirastes?: { attachmentId?: string } } & Record<string, unknown>;
}

// ============================================================================
// Attachments
// ============================================================================

/** A file in the composer, read and checked, waiting to be sent. */
export interface ChatAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** Bytes after `prepare`. */
  size: number;
  /** `data:` URL sent to the server. */
  url: string;
  /** Thumbnail source for images. */
  previewUrl?: string;
}

/**
 * Attachment limits of the composer. The SDK neither compresses nor scales
 * images; use `prepare` to do that before the size check.
 */
export interface ChatAttachmentOptions {
  /** Default true when the options object is given. */
  enabled?: boolean;
  /** Default PNG, JPEG, WebP, GIF and PDF. */
  mediaTypes?: ReadonlyArray<string>;
  /** Files per message. Default 10. */
  maxFiles?: number;
  /** Bytes per file after `prepare`. Default 20,000,000. */
  maxFileBytes?: number;
  /** Runs on each accepted file before the size check, e.g. to compress an image. */
  prepare?: (file: File) => Promise<File | Blob> | File | Blob;
}

/** Hidden `<input type="file">` wiring of the composer: `<input {...attachmentInputProps} />`. */
export interface ChatAttachmentInputProps {
  ref: RefObject<HTMLInputElement | null>;
  type: 'file';
  multiple: true;
  accept: string;
  hidden: true;
  tabIndex: -1;
  'aria-hidden': true;
  onChange: (event: { currentTarget: HTMLInputElement }) => void;
}

export interface ToolInvocationPart {
  type: 'tool-invocation';
  toolInvocationId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: 'partial-call' | 'call' | 'approval-requested' | 'output-available';
  result?: unknown;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolInvocationId: string;
  toolName: string;
  result: unknown;
}

// ============================================================================
// Truncation
// ============================================================================

export interface TruncationInfo {
  completedTools: string[];
  message: string;
}

export interface PipelineStepUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PipelineStepReport {
  stepNumber: number;
  finishReason: string;
  toolCalls: string[];
  toolResults: number;
  requiresApproval: boolean;
  pendingApprovals: number;
  summary: string;
  usage: PipelineStepUsage;
  createdAt: string;
}

export type PipelineStatus =
  | 'running'
  | 'completed'
  | 'safety-stop'
  | 'aborted'
  | 'error';

export interface PipelineState {
  status: PipelineStatus;
  totalSteps: number;
  finishReason?: string;
  maxSteps: number;
  stepLimitSource: 'explicit' | 'module' | 'safety' | 'runtime-budget';
  updatedAt: string;
  message?: string;
}

// ============================================================================
// Mention Types
// ============================================================================

export interface MentionResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon?: string;
  /** Stable list identity when several providers may return the same id. */
  key?: string;
  /** Token text after the trigger; defaults to a slug of `label`. */
  slug?: string;
  /** Tool-backed commands: the catalog definition to run (see `CompletionItem`). */
  definitionId?: string;
  /** Tool-backed commands: fixed arguments for the definition. */
  args?: Readonly<Record<string, unknown>>;
  /** Entity actions offered next to this result (see `CompletionItem.actions`). */
  actions?: ReadonlyArray<CompletionItemAction>;
  /** Heading the list shows above this hit's group. */
  group?: string;
}

export interface MentionData {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface MentionConfig {
  search: (query: string, type: string) => Promise<MentionResult[]>;
  resolve: (id: string, type: string) => Promise<MentionData>;
  types: string[];
  serialize?: MentionSerializationConfig;
}

// ============================================================================
// Completion Providers ('/' commands and '@' mentions)
// ============================================================================

/**
 * What the app UI knows about the signed-in user. Providers use it to hide
 * entries; it never authorizes anything (the server and the app do).
 */
export interface CompletionPermissionContext {
  readonly roles?: ReadonlyArray<string>;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface CompletionItem {
  /** The app's own stable id; it reaches the model via the mention marker. */
  id: string;
  /** Mention type, e.g. `user`, `task`, `command`. */
  type: string;
  label: string;
  description?: string;
  slug?: string;
  /**
   * Tool-backed commands: the catalog definition to run. Set it when `id` is
   * not the definition id (several commands share one definition) or `args`
   * are present; it reaches the model next to the id on send.
   */
  definitionId?: string;
  /** Fixed arguments for `definitionId` (needs `definitionId`), e.g. `{ destination: 'overview' }`. */
  args?: Readonly<Record<string, unknown>>;
  /**
   * Context actions of an `@` entity (e.g. "Open", "Complete"), offered next
   * to it in the list and reachable by keyboard (ArrowRight/ArrowLeft).
   */
  actions?: ReadonlyArray<CompletionItemAction>;
  /** Heading the list shows above this hit's group. */
  group?: string;
}

export interface CompletionItemAction {
  /** Action id (`[A-Za-z0-9._-]`, max 200). */
  id: string;
  label: string;
}

export interface CompletionSearchRequest {
  query: string;
  trigger: string;
  /** Aborted when a newer search starts; pass it to `fetch`. */
  signal: AbortSignal;
  context: CompletionPermissionContext;
  limit: number;
}

export interface ChatCompletionProvider {
  /** Stable, unique provider id (`[a-z0-9-]`, max 40). */
  id: string;
  /**
   * The character that opens this provider's list: `@`, `/` or any other
   * single non-whitespace character (e.g. `#`). Describe a new one in
   * `AiChatProviderConfig.triggers` to set its prefix or pick behavior.
   */
  trigger: string;
  search(
    request: CompletionSearchRequest,
  ): Promise<ReadonlyArray<CompletionItem>> | ReadonlyArray<CompletionItem>;
}

/**
 * What picking an entry of a trigger's list does. `chip` (default) inserts a
 * pill. `text`, `run` and `list` are reserved for the pick behaviors of later
 * releases; today every kind inserts a pill.
 */
export type CompletionSelectKind = 'chip' | 'text' | 'run' | 'list';

/** A character that opens a completion list in the composer. */
export interface ChatTriggerDefinition {
  /** Exactly one character, not whitespace, e.g. `#`. */
  char: string;
  /** Name of the trigger in composer menus. */
  label?: string;
  /** Visible prefix of a picked pill; defaults to `char`. Commands keep `/`. */
  prefix?: string;
  /** Default pick behavior of the trigger's entries; default `chip`. */
  select?: CompletionSelectKind;
  /**
   * Mention item types this trigger owns, e.g. `['ticket']`. The wire format
   * (`{{mention:type:id:label}}`) carries no prefix, so sent messages, restored
   * history and session titles show a mention of these types with `prefix`;
   * other types keep `@`. A type belongs to one trigger at most; `command`
   * always stays `/`.
   */
  types?: ReadonlyArray<string>;
}

/** A trigger with its defaults applied (`resolveChatTriggers`). */
export type ResolvedChatTrigger = Required<Pick<ChatTriggerDefinition, 'char' | 'prefix' | 'select'>> & {
  label?: string;
  types?: ReadonlyArray<string>;
};

/** A catalog UI tool offered as a `/` command. */
export interface UiToolCommandSource {
  readonly definitionId: string;
  /**
   * Stable, unique list identity and mention id of this command; defaults to
   * `definitionId`. One definition can back several commands (a single
   * `ui.navigate` with a `destination` enum becomes one command per
   * destination). No `:` or `}`, max 200 characters.
   */
  readonly commandId?: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: ReadonlyArray<string>;
  /** Fixed arguments the command passes to the definition, e.g. `{ destination: 'overview' }`. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Empty or omitted: visible to everyone. */
  readonly allowedRoles?: ReadonlyArray<string>;
}

export interface MentionSerializationConfig {
  enabled?: boolean;
  includeContextBlock?: boolean;
  contextLabel?: string;
}

// ============================================================================
// Session Persistence
// ============================================================================

/**
 * Lightweight summary of a chat session used by the built-in session
 * switcher and any consumer UI that needs to list sessions.
 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  messageCount?: number;
  status?: 'active' | 'archived' | string;
}

/**
 * A "wire" chat message — the shallow shape most backends persist
 * (single string body, flat role). Accepted by `SessionConfig.load`
 * alongside the full `ChatMessage` shape; the provider coerces it into
 * SDK messages automatically so consumer bridges don't have to map
 * `content → parts[0].text` themselves.
 */
export interface WireChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string | null;
  createdAt?: string | number | Date;
}

/**
 * Session persistence / multi-session hooks.
 *
 * The original single-session surface (`save`, `load`, `clear`) is still
 * supported — set `defaultActiveId` (or leave it unset for `'default'`)
 * and the SDK behaves exactly as before.
 *
 * To opt into multi-session: provide `list`, `create`, and `remove` (and
 * optionally `rename`). When all three are defined, `sessionsSupported`
 * on the chat context becomes `true` and the built-in `SessionSwitcher`
 * component renders.
 */
export interface SessionConfig {
  /** Persist messages for a session. Called after each message change. */
  save?: (conversationId: string, messages: ChatMessage[]) => void | Promise<void>;
  /**
   * Load previously-stored messages for a session. Called on mount and
   * on switch. Return either full SDK `ChatMessage`s (with `parts`) or
   * flat `WireChatMessage`s (with `content`) — the provider coerces
   * the wire shape automatically.
   */
  load?: (
    conversationId: string,
  ) =>
    | Array<ChatMessage | WireChatMessage>
    | null
    | Promise<Array<ChatMessage | WireChatMessage> | null>;
  /**
   * Clear stored messages for a session. The optional id is the session
   * being cleared; when omitted the consumer may treat it as "the active
   * session" (pre-existing single-session behavior).
   */
  clear?: (conversationId?: string) => void | Promise<void>;

  // ---- Multi-session surface (all optional) ----

  /** Fetch the list of sessions for the current user. */
  list?: () => Promise<SessionSummary[]>;
  /** Create a new session. The returned summary becomes the active session. */
  create?: (opts?: { title?: string }) => Promise<SessionSummary>;
  /** Delete / archive a session. */
  remove?: (conversationId: string) => Promise<void>;
  /** Rename a session. */
  rename?: (conversationId: string, title: string) => Promise<void>;

  /** Controlled active session id. When set, the consumer owns the state. */
  activeId?: string;
  /** Initial active session id in uncontrolled mode. Default: `'default'`. */
  defaultActiveId?: string;
  /** Fires when the active session changes (both controlled and uncontrolled). */
  onActiveIdChange?: (id: string) => void;

  /** Attachment files kept next to the chats, so the provider can reuse them. */
  attachments?: AttachmentBlobStore;
}

// ============================================================================
// Mention Chip Types (chat-react–specific, not in contracts)
// ============================================================================

export interface Mention {
  id: string;
  type: string;
  displayName: string;
  slug?: string;
  prefix?: string;
  [key: string]: unknown;
}

// ============================================================================
// Tool Label Config
// ============================================================================

export interface ToolLabelConfig {
  labels?: Record<string, { singular: string; plural: string }>;
}

export type ToolResultDisplayMode = 'default' | 'hidden' | 'allowlist';

export interface ToolResultDisplayConfig {
  mode?: ToolResultDisplayMode;
  allowlist?: string[];
}

/** Layout of the work log of an assistant turn (`ActivityLog`). */
export interface ActivityLogConfig {
  /**
   * Open the log while its turn runs and collapse it again when the turn is
   * over; a log the user toggles keeps the user's choice. Default false
   * (collapsed until the user opens it).
   */
  expandWhileRunning?: boolean;
  /**
   * Count the finished steps in the running summary
   * (`activityRunningProgressLabel`: "2 done, Listing devices…"). Default
   * false (only the running tool: `activityRunningLabel`).
   */
  runningProgress?: boolean;
  /**
   * Where the stop or error notice of the latest turn goes: `'log'` (default)
   * as the last line inside the collapsible log, `'message'` as its own
   * element (`data-component="turn-notice"`) right after the log, visible
   * while the log is collapsed. A turn without steps always shows it as its
   * own element.
   */
  noticePlacement?: 'log' | 'message';
  /**
   * Which turns show their stop or error notice. `'every'` (default): every
   * turn whose recorded outcome (`TurnOutcome`) is not `completed`, also
   * after later turns and a reload, at the same place as for the latest
   * turn; a turn that ended before an assistant message existed shows it as
   * its own element right after its user message (`components.TurnNotice`,
   * placement `'message'`; default `<p data-component="turn-notice">`).
   * `'latest'`: only the latest turn while no later one started, never for a
   * turn without an assistant message (the behaviour before 0.20.0).
   */
  noticeScope?: 'latest' | 'every';
  /**
   * Which steps show their detail line (`data-element="detail"`: the error
   * text, a done step's message):
   * - `'auto'` (default): a failed or neutral (`expected`) step shows the
   *   error text its tool returned, and a call the user approved that the
   *   server did not run shows `activityApprovalNotUsedDetail`, whatever the
   *   result display (`toolResults`); a done step shows its message, and an
   *   SDK-level `output-error` its text, only where its result is displayed.
   * - `'results'`: every step only where its result is displayed (the rule
   *   before 0.18.0, also for failures).
   * - `'all'`: every step that has a detail.
   * - `'none'`: no step.
   */
  details?: ActivityLogDetails;
  /**
   * `'message'` (default): one log for all steps of a message, before its
   * text. `'sections'`: when an assistant message interleaves text and tool
   * steps (text, steps, text), each run of steps gets its own log at its
   * place between the texts, in message order; a message whose steps all
   * come before its text renders exactly as with `'message'`.
   */
  grouping?: 'message' | 'sections';
}

/** Detail policy of the activity log steps (`ActivityLogConfig.details`). */
export type ActivityLogDetails = 'auto' | 'results' | 'all' | 'none';

/** Pipeline status of a turn that ends with a notice. */
export type TurnNoticeStatus = 'safety-stop' | 'aborted' | 'error';

export interface TurnNoticeProps {
  /** Locale text of the status (`pipelineSafetyStopLabel`, `pipelineAbortedLabel`, `pipelineErrorLabel`). */
  text: string;
  status: TurnNoticeStatus;
  /** `'log'` inside the activity log, `'message'` as its own part of the message. */
  placement: 'log' | 'message';
  /** The recorded outcome of the turn the notice belongs to, when there is one (`useTurnOutcome`). */
  outcome?: TurnOutcome;
}

/** How a turn ended: the end states of `PipelineState.status`. Every one but `completed` has a notice. */
export type TurnOutcomeStatus = 'completed' | TurnNoticeStatus;

/**
 * Why a turn ended so: `finished` the run ended by itself, `stopped` the
 * user's `stop()`, `send-now` a `sendNow` with `sendNowBehavior: 'abort'`,
 * `request-failed` a transport error, `pipeline` a stop, safety stop or error
 * the server reported (`data-pipeline-state`).
 */
export type TurnOutcomeReason = 'finished' | 'stopped' | 'send-now' | 'request-failed' | 'pipeline';

/**
 * The recorded end of a turn, keyed by the user message that started it, also
 * when no assistant message exists (a stop or a failure before the first
 * token). Kept while later turns run and, with `session.save`/`load`, across
 * a reload (in the stored user message's `metadata.glirastesTurnOutcome`; the
 * provider takes the key out of the history its transport holds, so the
 * chat's requests do not carry it). It belongs to the chat and user message
 * its request was started for, also when another chat was opened meanwhile.
 * A new request for the same user message (a retry) replaces it with the
 * outcome of the new attempt. Status and reason only.
 */
export interface TurnOutcome {
  /** Id of the user message that started the turn. */
  userMessageId: string;
  status: TurnOutcomeStatus;
  reason: TurnOutcomeReason;
  /** ISO time it was recorded. */
  at: string;
}

/** The second argument of `onTurnEnd`. */
export interface TurnEndInfo {
  /** The chat the turn belongs to (`session.activeId`, else `'default'`); always the chat that is open. */
  sessionId: string;
}

/**
 * Called once when a turn of the open chat ends, with its recorded outcome
 * (the same object `turnOutcomes` holds by then). See
 * `AiChatProviderConfig.onTurnEnd`.
 */
export type OnTurnEnd = (outcome: TurnOutcome, info: TurnEndInfo) => void;

/**
 * The rendered parts of one message, each `null` when absent. Order of the
 * default bubble: plan, activity, notice, attachments, text, toolResults.
 */
export interface MessagePartNodes {
  /** `PlanChecklist` of the latest `update_plan` call. */
  plan: ReactNode;
  /** `ActivityLog` of the turn's tool steps. */
  activity: ReactNode;
  /** The turn notice when it is shown outside the log (`noticePlacement`, or a turn without steps). */
  notice: ReactNode;
  /** Sent files and images. */
  attachments: ReactNode;
  /** Text parts (Markdown, mention chips) or the fallback summary of a text-less message. */
  text: ReactNode;
  /** Tool result blocks, custom renderers and clarification cards. */
  toolResults: ReactNode;
}

export interface MessageParts extends MessagePartNodes {
  /** False for a message with nothing to show; the default bubble renders nothing then. */
  visible: boolean;
  /** Every part of the message in message order, each with its default rendering. */
  parts: MessagePartEntry[];
  /** The recorded outcome of the message's turn, else null (a turn still running, an older stored one). */
  turnOutcome: TurnOutcome | null;
}

export interface MessagePartsProps extends MessagePartNodes {
  message: ChatMessage;
  /** The recorded outcome of the message's turn, else null (a turn still running, an older stored one). */
  turnOutcome?: TurnOutcome | null;
  /** Every part of the message in message order, each with its default rendering (`node`). */
  parts: MessagePartEntry[];
  /** All parts in the default order. */
  children: ReactNode;
}

/** `text`, `tool` (an AI SDK tool part or a `tool-result`), `file`, or `other` (reasoning, step markers, data). */
export type MessagePartKind = 'text' | 'tool' | 'file' | 'other';

/**
 * One part of a message in message order, for a layout that places its own
 * content at the position of a part (`MessageParts.parts`).
 */
export interface MessagePartEntry {
  /** Stable across renders: `tool:<toolCallId>` for a tool part, else `<kind>:<index>`. */
  key: string;
  /** Position in `message.parts`. */
  index: number;
  kind: MessagePartKind;
  part: ChatMessage['parts'][number];
  /** Model-facing tool name of a tool part. */
  toolName?: string;
  toolCallId?: string;
  /**
   * What the default bubble renders for this part: the text (Markdown,
   * mention chips), the tool result block, renderer or clarification card,
   * the approval entry or inline card (`approvalDisplay`), the attachment.
   * `null` when the part shows nothing here (a hidden result, a step only
   * the activity log names, a reasoning part).
   */
  node: ReactNode;
  /** The approval of a tool part that asked for one, open or decided. */
  approval?: ToolPartApproval;
}

/** What the user answered on an approval card. */
export type ApprovalDecision = 'approved' | 'declined';

/**
 * What became of a call that asked for approval: `open` waits for the
 * user; `running` approved, no result yet; `done`, `failed`, `expected` (a
 * neutral failure, as in the activity log) its result; `declined` the user
 * said no; `not-run` the user approved, but the server did not run it (an
 * expired or already used approval); `aborted` the user approved, but the
 * turn ended without a result (stopped, the request failed, a stored
 * history) and no automatic resend is pending.
 */
export type ApprovalOutcome = 'open' | 'running' | 'done' | 'failed' | 'expected' | 'declined' | 'not-run' | 'aborted';

/**
 * The approval of one tool part, open or decided, as the browser can still
 * tell it from the message (also after a reload): the card's description and
 * detail lines and the ids with the names this conversation shows now.
 * Display only and local: nothing of it is sent anywhere.
 */
export interface ToolPartApproval {
  approvalId: string;
  toolCallId?: string;
  toolName: string;
  state: 'open' | 'decided';
  /** Absent while open. */
  decision?: ApprovalDecision;
  outcome: ApprovalOutcome;
  /** The card's description (`approvalDescription`), else the tool name. */
  label: string;
  details?: string[];
  /** The server's subjects (`source: 'server'`, `check`, `reason`) where the call has them, else the history's. */
  subjects?: ApprovalSubject[];
  /** The server's preview of the call, as on the card (`PendingApproval.preview`). */
  preview?: ApprovalPreviewItem[];
  /** `unchecked`: the server could not load the preview. */
  previewCheck?: 'found' | 'unchecked';
  /** The open approval as the card gets it; only while `state` is `open`. */
  pending?: PendingApproval;
}

export interface ApprovalEntryProps {
  approval: ToolPartApproval;
}

/** Where approvals show in the chat (`AiChatProvider` `approvalDisplay`). */
export interface ApprovalDisplayConfig {
  /**
   * A decided approval: `'none'` (default) shows nothing beyond the activity
   * log, `'entry'` a lasting `ApprovalEntry` (or `components.ApprovalEntry`)
   * at the tool part's position: what was approved or declined and what
   * became of it, also after a reload.
   */
  decided?: 'none' | 'entry';
  /**
   * The open approval card: `'panel'` (default) below the messages, bulk
   * cards for several calls of one tool; `'inline'` at the tool part's
   * position inside the message, one card per call. A custom `MessageBubble`
   * that does not render `parts` or `toolResults` must place it itself.
   */
  open?: 'panel' | 'inline';
}

export interface VoicePushToTalkConfig {
  /**
   * Hold this combo to talk; `mod` is ⌘ on macOS and Ctrl elsewhere.
   * Default `mod+shift+space`. `false` disables only the hotkey. Only one
   * visible composer per page owns a combo, so it never opens two microphones.
   */
  hotkey?: string | false;
  /**
   * Holding the mic button at least this long (default 350 ms) stops on
   * release; a shorter tap toggles recording on.
   */
  holdThresholdMs?: number;
}

export interface VoiceInputConfig {
  enabled?: boolean;
  language?: string;
  baseUrl?: string;
  /** URL of the audio worklet file; default `/audio-worklet-processor.js`. */
  workletUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => MaybePromise<string | null | undefined>;
  /**
   * Speech provider adapter; defaults to the Deepgram speech-stream adapter.
   * Keep its identity stable: a new adapter restarts the controller.
   */
  adapter?: import('./stt/controller.js').SttProviderAdapter;
  /** Push-to-talk in addition to tap-to-toggle; `false` keeps toggle only. */
  pushToTalk?: VoicePushToTalkConfig | false;
  /**
   * Pass the current route (e.g. `usePathname()`); a change stops recording
   * and keeps the speech as editable draft. Back/forward is detected too.
   */
  routeKey?: string;
  recordingBar?: {
    enabled?: boolean;
    variant?: 'trigger' | 'inline';
  };
  onError?: (error: string) => void;
}

// ============================================================================
// Suggestion Types
// ============================================================================

export interface SuggestionsConfig {
  enabled?: boolean;
  count?: number;
  autoSuggest?: boolean;
  staticChips?: string[];
  rotationInterval?: number;
}

// ============================================================================
// ClassNames
// ============================================================================

export interface ChatClassNames {
  panel?: string;
  messageList?: string;
  messageBubble?: string;
  input?: string;
  approvalCard?: string;
  suggestionChip?: string;
  mentionChip?: string;
  bulkApprovalCard?: string;
  pipelineTimeline?: string;
  /**
   * The floating chat window `<section>`. Set this to apply Tailwind
   * classes for sizing, background, border, shadow, etc. When set,
   * the SDK's inline width/height styles are dropped so your class
   * wins — e.g. `classNames={{ window: 'w-[500px] h-[400px] bg-slate-900' }}`.
   */
  window?: string;
  /** The draggable header bar at the top of the chat window. */
  windowHeader?: string;
  /** The scrollable body region that wraps `<AiChatPanel />`. */
  windowBody?: string;
  /** The floating trigger pill (outer portal wrapper). */
  trigger?: string;
  /** The pill-shaped button inside the trigger. */
  triggerPill?: string;
  /** The session switcher dropdown root. */
  switcher?: string;
  /** The message queue above the composer (`ChatQueue`). */
  chatQueue?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// Component Overrides
// ============================================================================

export interface ChatComponents {
  MessageBubble?: ComponentType<MessageBubbleProps>;
  ChatInput?: ComponentType<ChatInputProps>;
  ToolResultBlock?: ComponentType<ToolResultBlockProps>;
  Markdown?: ComponentType<MarkdownProps>;
  InputExtra?: ComponentType<Record<string, never>>;
  ApprovalCard?: ComponentType<ApprovalCardProps>;
  BulkApprovalCard?: ComponentType<BulkApprovalCardProps>;
  PipelineTimeline?: ComponentType<PipelineTimelineProps>;
  SuggestionChip?: ComponentType<SuggestionChipProps>;
  MentionChip?: ComponentType<MentionChipProps>;
  ClarificationCard?: ComponentType<ClarificationCardProps>;
  /** Pending attachments above the editor. */
  AttachmentTray?: ComponentType<AttachmentTrayProps>;
  /** Paperclip button that opens the file picker. */
  AttachmentButton?: ComponentType<AttachmentButtonProps>;
  /** Form for the missing arguments of a `/` command or entity action. */
  CommandArgumentsForm?: ComponentType<CommandArgumentsFormProps>;
  /** Item of the `@`/`/` suggestion list; it must spread `optionProps`. */
  MentionDropdownItem?: ComponentType<MentionDropdownItemProps>;
  /** Stop or error notice of the latest turn, inside the activity log or outside it (`activityLog.noticePlacement`). */
  TurnNotice?: ComponentType<TurnNoticeProps>;
  /**
   * Arranges the parts of a message inside the bubble root, e.g. the text in
   * a bubble of its own and the work log beside it. Without it the parts
   * render in the default order.
   */
  MessageParts?: ComponentType<MessagePartsProps>;
  /** Lasting entry of a decided approval (`approvalDisplay.decided: 'entry'`). */
  ApprovalEntry?: ComponentType<ApprovalEntryProps>;
  /**
   * The message queue above the composer (`queue.enabled`). Replaces the
   * default `ChatQueue`; `null` hides it (the app renders the queue itself).
   */
  ChatQueue?: ComponentType<ChatQueueProps> | null;
}

export interface CommandArgumentsFormProps {
  pending: PendingChatCommand;
  /** Values by argument name, and the labels of picked entities. */
  onSubmit: (values: Readonly<Record<string, string>>, valueLabels: Readonly<Record<string, string>>) => void;
  onCancel: () => void;
}

// ============================================================================
// Locale (internal — English-only, not publicly configurable)
// ============================================================================

/**
 * All user-facing strings rendered by the SDK's built-in components.
 * Every key is overridable via `AiChatProviderConfig.locale` so consumers
 * can bind them to `next-intl`, `react-i18next`, or any other i18n stack.
 */
export interface ChatLocale {
  placeholder: string;
  sendButton: string;
  stopButton: string;
  clearButton: string;
  loadMoreButton: string;
  emptyState: string;
  errorMessage: string;
  approveButton: string;
  rejectButton: string;
  approveAllButton: string;
  rejectAllButton: string;
  continueButton: string;
  dismissButton: string;
  cancelButton: string;
  confirmButton: string;
  moreItemsLabel: string;
  showAllItemsLabel: string;         // supports `{count}`
  showMoreLabel: string;
  showLessLabel: string;
  allCountLabel: string;
  pipelineTitle: string;
  pipelineRunningLabel: string;
  pipelineCompletedLabel: string;
  pipelineSafetyStopLabel: string;
  pipelineAbortedLabel: string;
  pipelineErrorLabel: string;
  pipelineStepLabel: string;
  pipelineApprovalPendingLabel: string;
  // Work log of an assistant turn and its optional plan
  activityWorkingLabel: string;
  activityWaitingLabel: string;
  /**
   * Steps that finished without failure, declined or neutral outcome;
   * supports `{count}`. Left out of the summary when no step is done
   * ("2 declined"). Before 0.18.0 `{count}` was every step.
   */
  activityDoneLabel: string;
  /** `activityDoneLabel` for one done step. */
  activityDoneOneLabel: string;
  activityFailedLabel: string;       // supports `{count}`
  /** Calls whose approval was declined (not counted as failed); supports `{count}`. */
  activityDeclinedLabel: string;
  /**
   * Calls that answered with a failure `classifyToolFailure` marked as
   * expected (a 404 the model then looks up, a 403): not counted as failed;
   * supports `{count}`.
   */
  activityExpectedLabel: string;
  /**
   * Calls still running when their turn ended without them (stopped, the
   * request failed, a stored history): not counted as failed; supports `{count}`.
   */
  activityAbortedLabel: string;
  /** Summary while a tool runs; `{label}` is the tool's label or `activityWorkingLabel` (`{label}…`). */
  activityRunningLabel: string;
  /** Running summary with `activityLog.runningProgress`; supports `{count}` (done steps, as `activityDoneLabel`) and `{label}`. */
  activityRunningProgressLabel: string;
  /** Count of a step line folding repeated calls; supports `{count}` (`×{count}`). */
  activityStepCountLabel: string;
  /** Joins the parts of the finished summary (`, `). */
  activitySummarySeparator: string;
  /** Step of a UI action whose outcome the chat waits for ("Waiting for the app"). */
  activityUiPendingLabel: string;
  /** The app refused the UI action's input. */
  activityUiRejectedContract: string;
  /** The app's handler declined the UI action. */
  activityUiRejectedHandler: string;
  /** Nothing on the open page carries the UI action out. */
  activityUiUnavailable: string;
  /** The UI action failed in the app. */
  activityUiFailed: string;
  /** The UI action started a page load. */
  activityUiInitiated: string;
  /** The app did not confirm the UI action. */
  activityUiUnconfirmed: string;
  /** Detail of a declined step the user approved but the server did not run (expired or already used approval). */
  activityApprovalNotUsedDetail: string;
  /*
   * Detail of a failed step whose text the SDK wrote itself (`StepFailureCode`,
   * `ActivityStep.failures`), shown instead of that English text. Each is
   * optional: a locale without it takes the built-in text of the language,
   * except where the app's own table words the activity log itself and the
   * language is not stated (`language`): then English, as before the keys.
   * A text of the app's backend or tool is shown as it is.
   */
  /** `failed`, and any code this version does not know: "AI request failed". */
  activityFailureGeneric?: string;
  /** `invalid-input`: the model's arguments did not match the tool's schema. */
  activityFailureInvalidInput?: string;
  /** `tool-unavailable`: the tool is not offered in this chat (agent, policy, manifest, unknown tool). */
  activityFailureToolUnavailable?: string;
  /** `not-permitted`: the user's role may not use the tool. */
  activityFailureNotPermitted?: string;
  /** `identity-missing`: the server could not identify the user. */
  activityFailureIdentityMissing?: string;
  /** `account-refused`: the call does not fit the user's account (tenant). */
  activityFailureAccountRefused?: string;
  /** `tool-disabled`: the tool was revoked. */
  activityFailureToolDisabled?: string;
  /** `refused`: refused for another reason. */
  activityFailureRefused?: string;
  /** `limit-reached`: the turn's budget, without a named limit. */
  activityFailureLimitReached?: string;
  /** `limit-tool-calls`; supports `{limit}`, as are the other `activityFailureLimit…` keys. */
  activityFailureLimitToolCalls?: string;
  activityFailureLimitModelSteps?: string;
  /** `{limit}` is the server's duration (`90 s`, `500 ms`). */
  activityFailureLimitTime?: string;
  activityFailureLimitInputTokens?: string;
  activityFailureLimitOutputTokens?: string;
  /** `{limit}` in USD. */
  activityFailureLimitCost?: string;
  activityFailureLimitRepeatedCalls?: string;
  activityFailureLimitConsecutiveErrors?: string;
  /** `record-not-found`: a record the call names does not exist or is not visible to the user. */
  activityFailureRecordNotFound?: string;
  /** `record-invalid-id`: an id the call names is not valid. */
  activityFailureRecordInvalidId?: string;
  /** `record-unchecked`: a record the call names could not be checked. */
  activityFailureRecordUnchecked?: string;
  /** `endpoint-failed`: the backend answered with an error and no message; supports `{status}`. */
  activityFailureEndpointFailed?: string;
  /** `endpoint-path-not-relative`: the endpoint caller refused a path off the API's origin. */
  activityFailureEndpointPathNotRelative?: string;
  /** `endpoint-path-not-allowed`: the endpoint caller refused a path outside `allowedPathPrefixes`. */
  activityFailureEndpointPathNotAllowed?: string;
  /** `endpoint-timeout`: supports `{tool}` (the tool's model-facing name). */
  activityFailureEndpointTimeout?: string;
  /** `endpoint-response-too-large`: supports `{tool}`. */
  activityFailureEndpointResponseTooLarge?: string;
  /** `memory-kind-unavailable`: the built-in memory tools (`memory_remember`, `memory_forget`). */
  activityFailureMemoryKindUnavailable?: string;
  /** `memory-full`: supports `{max}`. */
  activityFailureMemoryFull?: string;
  activityFailureMemorySaveFailed?: string;
  activityFailureMemoryNoteMismatch?: string;
  activityFailureMemoryRemoveFailed?: string;
  activityFailureMemoryNoteNotFound?: string;
  /** Outcome of a decided approval (`ApprovalEntry`): approved, no result yet. */
  approvalEntryRunningLabel: string;
  /** Approved and done. */
  approvalEntryDoneLabel: string;
  /** Approved, the call failed. */
  approvalEntryFailedLabel: string;
  /** Approved, the call answered with a neutral failure (as `activityExpectedLabel`). */
  approvalEntryExpectedLabel: string;
  /** Declined by the user. */
  approvalEntryDeclinedLabel: string;
  /** Approved, but the server did not run it (expired or already used approval). */
  approvalEntryNotRunLabel: string;
  /** Approved, but the turn ended without a result (stopped, the request failed, a stored history). */
  approvalEntryAbortedLabel: string;
  planTitle: string;
  /** Shown when the user sends while an approval card waits for a decision. */
  approvalPendingHint: string;
  /** Label of a bare `id` argument whose entity type is not known ("Target"). */
  approvalTargetLabel: string;
  /** Warning on an approval card for one id no name was shown for in this conversation. */
  approvalUnknownIdWarning: string;
  /** The same warning for several ids. */
  approvalUnknownIdsWarning: string;
  /** Warning for an id shown with different names; supports `{names}`. */
  approvalAmbiguousIdWarning: string;
  /**
   * Warning for an id seen for records of different kinds (user 3, playlist 3)
   * when the call does not say which one it means; supports `{candidates}`
   * (`Linus Torvalds (User), Lobby Loop (Playlist)`).
   */
  approvalCollidingIdWarning: string;
  /** Note next to an id a tool result of this conversation carried without a name (no warning). */
  approvalSeenIdNote: string;
  /**
   * Warning for one id the server could not check right now (lookup timed
   * out, source unavailable); supports `{label}` and `{id}`. Not the same as
   * `approvalUnknownIdWarning`: the record may well exist.
   */
  approvalSubjectUncheckedWarning: string;
  /** The same warning for several ids; supports `{ids}` (`Playlist p1, Version 3`). */
  approvalSubjectsUncheckedWarning: string;
  /** Quiet note next to a referenced id the server did not look up and no name is known for. */
  approvalReferenceIdNote: string;
  /** Quiet note when the server could not load the preview of a call. */
  approvalPreviewUncheckedNote: string;

  // Floating widget / chat window chrome
  chatTitle: string;                 // default header title ("AI Assistant")
  closeChatAriaLabel: string;        // close button aria / tooltip
  clearChatAriaLabel: string;        // trash button aria / tooltip
  confirmClearPrompt: string;        // window.confirm() text
  triggerAriaLabel: string;          // floating pill aria
  micAriaLabel: string;
  stopRecordingAriaLabel: string;
  cancelRecordingAriaLabel: string;

  // Session switcher
  newChatLabel: string;              // "+ New chat" row + default new session title
  noSessionsLabel: string;           // empty state
  sessionsLoadingLabel: string;      // loading state
  untitledSessionLabel: string;
  deleteSessionAriaLabel: string;
  confirmDeleteSessionPrompt: string;
  sessionArchiveMessage: string;     // supports `{title}`
  renameSessionAriaLabel: string;
  renameSessionPlaceholder: string;

  // Structured clarification
  clarificationInputLabel: string;
  clarificationSubmitButton: string;

  // Speech-to-text
  retryRecordingAriaLabel: string;

  // `@` and `/` suggestions
  completionListLabel: string;
  completionResultsLabel: string;     // supports `{count}`
  /** Hint when a `@`/`/` search finds nothing. */
  completionEmptyLabel?: string;

  // Arguments of `/` commands and entity actions
  commandArgumentsLabel: string;      // supports `{command}`
  commandArgumentsSubmit: string;
  commandArgumentsInvalid: string;
  commandArgumentsIncomplete: string; // supports `{fields}`: required values still missing, or a person typed but not picked
  commandArgumentsAnyOption: string;
  commandArgumentsNoMatches: string;

  // Pills and entity chips
  removeMentionLabel: string;         // supports `{label}`
  openEntityLabel: string;            // supports `{label}`
  chatAboutLabel: string;             // a "Chat about this" menu entry (`useChatComposer`)
  // Attachments
  attachButtonLabel: string;
  attachmentsLabel: string;
  removeAttachmentLabel: string;      // supports `{name}`
  openAttachmentLabel: string;        // supports `{name}`
  attachmentAddedLabel: string;       // supports `{name}`
  attachmentUnavailableLabel: string;
  attachmentTooLarge: string;         // supports `{name}` and `{size}`
  attachmentTypeNotAllowed: string;   // supports `{name}`
  attachmentTooMany: string;          // supports `{count}`
  attachmentReadFailed: string;       // supports `{name}`
  attachmentCommandRefused: string;
  attachmentUnsupported: string;
  // Message queue (`queue.enabled`)
  queueTitle: string;                 // supports `{count}`
  queueSendNowLabel: string;
  queueEditLabel: string;
  queueRemoveLabel: string;
  queuePausedLabel: string;
  queueResumeLabel: string;
  queueSaveLabel: string;
  queueCancelLabel: string;
  queueFilesLabel: string;            // supports `{count}`
  /**
   * The approval notice while a queued message waits for an open approval.
   * Optional: without it the chat uses the app's own `approvalPendingHint`
   * when it set one, else the built-in text ("Message waits until the
   * approval is decided.").
   */
  queueApprovalWaitingHint?: string;
}

// ============================================================================
// Callback Types
// ============================================================================

/** Preprocess message text before sending */
export type OnBeforeSend = (text: string, mentions: MentionData[]) => string;

/**
 * Called when a tool result of the running request arrives — useful for
 * app-specific dispatching. Results restored from a stored history (session
 * load, messages set by the host or a custom transport) do not call it.
 */
export type OnToolResult = (toolName: string, result: unknown) => void;

/**
 * What became of the generated UI actions (`glirastes.*`) of one tool
 * result. No payload: only the tool, the action ids and the outcome.
 */
export interface UiActionOutcomeEvent {
  toolName: string;
  toolCallId: string;
  /**
   * `ok`, `rejected-contract`, `rejected-handler`, `unavailable`, `failed`,
   * `initiated` (a reloading navigation started), `timeout` (a handler did
   * not settle in time) or `unconfirmed` (a bus of an older SDK copy).
   */
  code: UiActionRunCode;
  actions: Array<{ type: string; actionId?: string }>;
  /**
   * Whether the outcome was written into the tool result for the model
   * (`outcome`): only for a result the server marked (`awaitsOutcome`), with
   * a transport that can write it (`addToolOutput`) and `uiActionOutcomes`
   * not `false`.
   */
  reported: boolean;
  durationMs: number;
  /** What a refusing or failing handler threw. */
  error?: unknown;
}

export type OnUiActionOutcome = (event: UiActionOutcomeEvent) => void;

/** What the chat knows beyond the arguments of the call to approve. */
export interface ApprovalDescriptionContext {
  /** Record names the tool results of this conversation reported (and the user's `@` mentions named), by lower-case record id. */
  names?: ReadonlyMap<string, string>;
}

/** Formats approval display for a given tool call */
export type ApprovalDescriptionFn = (
  toolName: string,
  approvalId: string,
  args: unknown,
  context?: ApprovalDescriptionContext,
) => PendingApproval;

/** Translates a pipeline state message (e.g. "Stopped by user.") before rendering. */
export type PipelineMessageTranslator = (message: string) => string;

/** Formats a pipeline step summary for display. Receives the full step for rich formatting. */
export type StepSummaryFormatter = (step: PipelineStepReport) => string;

// ============================================================================
// Message queue
// ============================================================================

/** A message the user sent while the chat was busy; it is processed when it is sent. */
export interface QueuedMessage {
  readonly id: string;
  /** The text as typed: commands, mention tokens and `onBeforeSend` apply when it is sent. */
  readonly text: string;
  /** ISO time it was queued. */
  readonly createdAt: string;
  /** The mentions active when it was queued. */
  readonly mentions?: ReadonlyArray<MentionData>;
  /** Attachments queued with it; never persisted through `queue.storage`. */
  readonly files?: ReadonlyArray<FilePart>;
}

/** Run endings that pause the queue (`queue.pauseOn`). `truncation`: the run left a continue prompt. */
export type ChatQueuePauseTrigger = 'error' | 'aborted' | 'safety-stop' | 'truncation';

export type ChatQueueChangeReason =
  | 'added'
  | 'removed'
  | 'edited'
  | 'reordered'
  | 'sent'
  | 'cleared'
  | 'paused'
  | 'resumed'
  | 'restored';

/** Passed to `queue.onQueueChange`; local only, nothing goes to the Platform. */
export interface ChatQueueChangeEvent {
  readonly queued: ReadonlyArray<QueuedMessage>;
  readonly paused: boolean;
  readonly reason: ChatQueueChangeReason;
}

/**
 * Keeps the queue of a conversation across reloads. Items with files are
 * left out (file data and object URLs do not survive a reload). A restored
 * queue starts paused.
 */
export interface ChatQueueStorage {
  load(sessionId: string): ReadonlyArray<QueuedMessage> | Promise<ReadonlyArray<QueuedMessage>>;
  save(sessionId: string, items: ReadonlyArray<QueuedMessage>): void | Promise<void>;
}

export interface ChatQueueConfig {
  /** Default false: without it nothing changes (the composer locks while busy, `send` refuses). */
  enabled?: boolean;
  /** Default true: send the next queued message once the chat is idle, one run at a time. */
  autoFlush?: boolean;
  /**
   * `sendNow(id)`: `'next'` (default) moves the message to the head and sends
   * it once idle (also when paused or without `autoFlush`); `'abort'` also
   * stops the running run first (that stop does not pause the queue).
   */
  sendNowBehavior?: 'next' | 'abort';
  /**
   * Most messages the queue holds; further sends are refused. Default 10
   * (each queued message is a model call nobody watches start); `Infinity`
   * or `null` lifts the limit.
   */
  maxSize?: number | null;
  /** Run endings that pause the queue until `resumeQueue()`. Default all four. */
  pauseOn?: ReadonlyArray<ChatQueuePauseTrigger>;
  /**
   * `sendNow` while an approval is open: `'refuse'` (default) returns false
   * and shows the approval hint; `'reject-approval'` rejects the open
   * approvals first.
   */
  sendNowDuringApproval?: 'refuse' | 'reject-approval';
  /** Optional persistence per conversation. */
  storage?: ChatQueueStorage;
  /** Called after every change; a throw is ignored. */
  onQueueChange?: (event: ChatQueueChangeEvent) => void;
}

/** What `submit` did with a message. */
export type ChatSubmitResult = 'sent' | 'queued' | 'rejected';

/**
 * Why a message was not taken. `session`: the conversation is not loaded or
 * is changing. `approval-open`: an approval waits (only without the queue;
 * with it the message is queued). `attachments-off`: files while attachments
 * are off. `files-with-command`: files with a direct `/` command. `queue-full`:
 * the queue holds `maxSize` messages.
 */
export type ChatSubmitRejectionReason =
  | 'session'
  | 'approval-open'
  | 'attachments-off'
  | 'files-with-command'
  | 'queue-full';

/** `submitWithResult`: what happened, and why for a refused message. */
export type ChatSubmitOutcome =
  | { readonly status: 'sent' | 'queued' }
  | { readonly status: 'rejected'; readonly reason: ChatSubmitRejectionReason };

/** The latest refused message (`lastRejection`): the reason and when (`Date.now()`), no content. */
export interface ChatSubmitRejection {
  readonly reason: ChatSubmitRejectionReason;
  readonly at: number;
}

/** `ChatContextValue.queue`. */
export interface ChatQueueState {
  readonly enabled: boolean;
  readonly items: ReadonlyArray<QueuedMessage>;
  readonly paused: boolean;
  /**
   * True while `queue.storage` is still reading the active conversation's
   * queue: nothing is sent meanwhile, new messages queue behind the stored ones.
   */
  readonly restoring: boolean;
  /** The message open in an editor (`beginEdit`); the queue holds when it reaches it. */
  readonly editingId: string | null;
}

/** The queue state and its actions (`useChatQueue`, `ChatQueue`'s render prop). */
export interface ChatQueueApi extends ChatQueueState {
  submit(message: string, options?: { mentions?: MentionData[]; files?: FilePart[] }): ChatSubmitResult;
  /** `submit` with the reason of a refusal. */
  submitWithResult(message: string, options?: { mentions?: MentionData[]; files?: FilePart[] }): ChatSubmitOutcome;
  /** The latest refused `send`/`submit`; null again after the next accepted one. */
  readonly lastRejection: ChatSubmitRejection | null;
  sendNow(id: string): boolean;
  removeQueued(id: string): boolean;
  editQueued(id: string, text: string): boolean;
  /** Opens a queued message for editing: it is not sent until `editQueued` or `cancelEdit` ends the edit. */
  beginEdit(id: string): boolean;
  cancelEdit(): void;
  clearQueue(): void;
  resumeQueue(): void;
  pauseQueue(): void;
}

export interface ChatQueueProps {
  className?: string;
  /** Renders the queue yourself; receives the state and actions. */
  children?: (queue: ChatQueueApi) => ReactNode;
}

// ============================================================================
// Provider Config
// ============================================================================

export interface AiChatProviderConfig {
  mentions?: MentionConfig;
  /**
   * Local compact result components per tool `definitionId` and schema
   * version. Memoize the array. Unknown tools, outputs that fail every
   * version's schema, and throwing renderers use the default block.
   */
  toolRenderers?: ReadonlyArray<AnyToolResultRenderer>;
  /**
   * Generic `/` and `@` providers. Memoize the array: a new identity
   * rebuilds the search. When set, the composer uses provider search with
   * keyboard navigation and keeps structured ids on send.
   */
  completionProviders?: ReadonlyArray<ChatCompletionProvider>;
  /**
   * Trigger characters of the composer beyond the provider's own: label,
   * pill prefix and pick behavior per char. `@` and `/` always open a list;
   * a provider's char without a definition gets `{ prefix: char, select: 'chip' }`.
   * An invalid or duplicate definition throws when the provider renders.
   * Memoize the array.
   */
  triggers?: ReadonlyArray<ChatTriggerDefinition>;
  completionContext?: CompletionPermissionContext;
  onCompletionProviderError?: (providerId: string, error: unknown) => void;
  /**
   * Declarative `@` entities and `/` commands: derived `data` (from
   * `useChatInteractionsData` or the generated module) plus app definitions
   * (`defineChatEntity`, `defineChatCommand`). Memoize the object. A `/`
   * command sent alone runs its tool without the model, through the server's
   * normal authorization and confirmation.
   */
  chatInteractions?: ChatInteractionsConfig;
  /**
   * Turns entity references in assistant messages into clickable chips:
   * app matchers (e.g. task keys), names the conversation already referenced,
   * and how a chip opens its entity. Memoize the object.
   */
  entityLinks?: ChatEntityLinksConfig;
  /**
   * Markdown rendering options for the default `Markdown` slot, e.g.
   * `{ remarkPlugins: [remarkGfm] }` for GFM tables. Memoize the object.
   */
  markdown?: ChatMarkdownOptions;
  /**
   * Shows the chat when `useChatComposer().open()` or `chatAbout()` asks for
   * it. Without it the surrounding `AssistantLayoutProvider` opens.
   */
  onOpenRequest?: () => void;
  toolResults?: ToolResultDisplayConfig;
  /** Work log layout: open while running, running progress, notice placement. All off by default. */
  activityLog?: ActivityLogConfig;
  /**
   * Message queue, off by default: with `enabled: true` a message sent while
   * a run is busy or an approval is open is queued instead of refused, and
   * the composer stays usable. See `docs/chat-queue.md`.
   */
  queue?: ChatQueueConfig;
  /**
   * File and image attachments in the composer (paste, drop, picker); off by
   * default. The server handler needs `attachments.enabled` too.
   */
  attachments?: boolean | ChatAttachmentOptions;
  voice?: VoiceInputConfig;
  session?: SessionConfig;
  classNames?: ChatClassNames;
  components?: ChatComponents;
  suggestions?: SuggestionsConfig;
  /**
   * Partial override for any user-facing string rendered by the SDK.
   * Omitted keys fall back to the built-in English defaults.
   *
   * ```tsx
   * const t = useTranslations('chat');
   * <LangGraphAiChat
   *   locale={{ sendButton: t('send'), placeholder: t('placeholder') }}
   * />
   * ```
   */
  locale?: Partial<ChatLocale>;
  /**
   * The chat's texts per BCP-47 language tag, to add a language (`pl`) or
   * change single texts of one, e.g. `{ pl: plChatLocale, de: { sendButton: 'Los' } }`.
   * The chat's language is the page's `lang`, else the one of the turn's
   * tool labels (`languageSource`). Per key: `locale`
   * (language-free, wins everywhere), then these tables and the built-in
   * German and English texts in the language's fallback order (the
   * language, another region of it, English). Partial tables are fine.
   */
  locales?: Readonly<Record<string, Partial<ChatLocale>>>;
  /**
   * Which language the chat's texts follow (`locales`, the built-in German
   * and English ones; also the date format of approval cards) when the app
   * states none (`language`):
   * - `'page'` (default): the page's `lang` (the UI the user reads), and
   *   only without one the language of the turn's tool labels (the server's
   *   `data-tool-presentation` part).
   * - `'server'`: the language of the tool labels first, then the page's
   *   `lang` (the order before 0.18.0).
   * The tool labels themselves come from the server in its turn language
   * (`requestLocale`, else the language this chat sends, see
   * `sendLanguage`); `toolLabels` overrides them.
   */
  languageSource?: 'page' | 'server';
  /**
   * The UI language the app states (BCP-47, e.g. from its router or i18n
   * stack): wins over the page's `lang` and the server's wording, whatever
   * `languageSource`. `<glirastes-chat>` passes its nearest `lang`.
   */
  language?: string;
  /**
   * Names the chat language (`language`, else the page's `lang`) in each
   * request as the `Content-Language` header (one BCP-47 tag), through a
   * transport that supports it (`useVercelAiChatTransport`, `VercelAiChat`,
   * `<glirastes-chat>`). The handler uses it as the turn language unless the
   * app set `requestLocale` or `locale` there (`clientLanguage`). Default
   * true; `false` sends none. Not sent with `languageSource: 'server'` or
   * without a known language. A header the app's `headers` set wins.
   */
  sendLanguage?: boolean;
  /**
   * Theme for the floating widget: a preset name (autocompleted by your
   * editor) or an override object. Defaults to `'professional-lightblue'`.
   *
   * ```tsx
   * <LangGraphAiChat theme="professional-dark" />
   * <LangGraphAiChat theme={{ preset: 'minimal-white', colors: { primary: '#10b981' } }} />
   * ```
   */
  theme?: ChatTheme;
  /**
   * `inline` (default) writes the theme as inline `--cm-*` variables on
   * widget roots. `inherit` leaves them to stylesheets and host variables;
   * `<glirastes-chat>` uses it so page CSS can theme the shadow root.
   */
  themeScope?: 'inline' | 'inherit';
  /**
   * Bring your own styles. Widget roots render `data-unstyled`, which turns
   * every rule of the shipped stylesheet off for them and everything inside,
   * and no theme variables are written. Markup, `data-*` hooks and
   * `classNames` stay, so the host stylesheet styles the chat on its own.
   */
  unstyled?: boolean;
  onToolResult?: OnToolResult;
  /**
   * Bus that receives the UI actions of generated tools (`ui.navigate`,
   * `ui.filter.<view>`, `ui.<actionId>`) after `onToolResult`. Defaults to
   * the page-wide bus of `glirastes/browser`.
   */
  uiActionBus?: UiActionBus;
  /**
   * Called once per tool result with generated UI actions, after its actions
   * ran (one tool result after another, in call order), with the outcome:
   * see `UiActionOutcomeEvent`. A throw inside is caught.
   */
  onUiActionOutcome?: OnUiActionOutcome;
  /**
   * Called once when a turn of the open chat ends, with its `TurnOutcome`
   * (every status: `completed`, `aborted` also by `sendNow` with `'abort'`,
   * `safety-stop`, `error` also before the first token or without any
   * assistant message), after the outcome is in `turnOutcomes`, with the
   * outcome `turnOutcomes` then holds. A turn ends when its last request is
   * over: not while it asks for an approval (also not after a safety stop on
   * that step: the decided run reports), not while a UI action outcome is
   * awaited (the continuation request belongs to the same turn), not on a
   * page a UI action is leaving with a page load (the next page continues the
   * turn and reports it), not at a stop or error the server reports while the
   * run still streams. A turn left at an undecided approval for a new message
   * reports what it recorded, if anything, when the new request starts. A
   * retry (`regenerate`) of the same user message is a new attempt and
   * reports its own end. Not called for outcomes read from a stored history
   * (`session.load`, a reload, a history the app hands its transport), for a
   * turn whose chat is not the open one when the turn ends (its outcome joins
   * that chat later without a call; a chat left and opened again before its
   * turn ended does report it), or for a run cleared with `clear()`. The
   * latest function passed is used; a throw inside, and the rejection of a
   * returned promise, is caught and logged. Local only.
   */
  onTurnEnd?: OnTurnEnd;
  /**
   * How long the handlers of one tool result may take before the outcome is
   * `timeout`; default 10 000 ms. Page-bound client actions get their route
   * wait (5 000 ms) on top.
   */
  uiActionOutcomeTimeoutMs?: number;
  /**
   * Outcome protocol of UI actions (default true): with a transport that has
   * `addToolOutput` (the bundled Vercel transport), the chat writes the
   * outcome into every tool result the server marked (`awaitsOutcome`), and
   * the model answers once all are reported; the composer stays locked
   * until then (at most until the timeout). `false` turns it off for this
   * chat: no flag in the request, nothing written, no second request.
   */
  uiActionOutcomes?: boolean;
  onBeforeSend?: OnBeforeSend;
  approvalDescription?: ApprovalDescriptionFn;
  /**
   * Show on each approval card the name this conversation showed for every id
   * the call carries, and warn (showing the id) about ids without one. Names
   * come from the browser's own message history: a convenience for the person
   * approving, not a trust boundary. Default true.
   */
  approvalSubjects?: boolean;
  /**
   * Where approvals show: a lasting entry for decided ones
   * (`decided: 'entry'`) and the open card inline at its tool part
   * (`open: 'inline'`). Default: as before (no entry, cards below the
   * messages).
   */
  approvalDisplay?: ApprovalDisplayConfig;
  /**
   * Declared identity by model-facing tool name, for apps whose server does
   * not send it: which records each tool result holds and which arguments
   * name one (`{ playlists_list: { output: [{ type: 'playlist', id:
   * 'playlist_id', name: 'displayName', path: 'playlists[]' }] } }`). The
   * built-in chat handler sends the tools' `outputEntities`/`inputEntities`
   * as a `data-tool-entities` part; these entries win over it per tool.
   * Used by approval names and subjects and entity links; without any, the
   * field-name guess applies as before. Memoize the object.
   */
  entityDeclarations?: EntityDeclarationsByTool;
  continueMessage?: string;
  toolLabels?: ToolLabelConfig;
  pipelineMessageTranslator?: PipelineMessageTranslator;
  stepSummaryFormatter?: StepSummaryFormatter;
}

// ============================================================================
// Theme
// ============================================================================

export type ChatThemePreset =
  | 'professional-lightblue'
  | 'professional-dark'
  | 'minimal-white'
  | 'vibrant-indigo'
  | 'terminal-green'
  | 'liquid-glass'
  | 'purple-haze'
  | 'blue-dream'
  | 'sunset-orange'
  | 'ocean-teal'
  | 'midnight-mono';

export interface ChatThemeColors {
  /** Accent color — send button, pill gradient start, active session row. */
  primary?: string;
  /** Second stop of the pill gradient + hover accents. */
  primarySoft?: string;
  /** Tinted background used for hover/active states. */
  primaryTint?: string;
  /** Chat panel background. */
  bg?: string;
  /** Secondary background — header strip, code blocks, suggestion chips. */
  bgMuted?: string;
  /** User message bubble background. */
  bubbleUser?: string;
  /** Assistant message bubble background. */
  bubbleAssistant?: string;
  /** Primary text color. */
  text?: string;
  /** Muted text (subtitles, timestamps). */
  textMuted?: string;
  /** Border color for separators, input, window edge. */
  border?: string;
  /** Danger color for delete actions and error banners. */
  danger?: string;
  /** `/` command pill background (`--cm-pill-command-bg`). Default: the primary tint. */
  pillCommand?: string;
  /** `/` command pill text (`--cm-pill-command-text`). Default: the primary color. */
  pillCommandText?: string;
  /** `@` entity pill background (`--cm-pill-entity-bg`). Default: a teal tint. */
  pillEntity?: string;
  /** `@` entity pill text (`--cm-pill-entity-text`). Default: teal mixed with the text color. */
  pillEntityText?: string;
}

export interface ChatThemeOverride {
  /** Base preset to inherit. Defaults to `'professional-lightblue'`. */
  preset?: ChatThemePreset;
  colors?: ChatThemeColors;
  /** Large radius — chat window, pill. Default: `0.875rem`. */
  radius?: string;
  /** Small radius — bubbles, inputs, buttons. Default: `0.5rem`. */
  radiusSmall?: string;
  /** Font stack for the entire widget. */
  fontFamily?: string;
}

export type ChatTheme = ChatThemePreset | ChatThemeOverride;

// ============================================================================
// Size
// ============================================================================

/**
 * Chat window size. Pass a preset or a concrete `{ width, height }` pair.
 *
 * | Preset  | Width × Height |
 * |---------|----------------|
 * | `sm`    | 360 × 560      |
 * | `md`    | 420 × 640 (default) |
 * | `lg`    | 520 × 720      |
 * | `xl`    | 640 × 820      |
 * | `full`  | 100% of viewport (mobile-style) |
 */
export type ChatSizePreset = 'sm' | 'md' | 'lg' | 'xl' | 'full';

/**
 * A single dimension value for the chat window. Accepts:
 * - `number` — pixel count (e.g. `500`)
 * - CSS length string — `'500px'`, `'40vw'`, `'70vh'`, `'60%'`, `'32rem'`
 *
 * Viewport units (`vw`, `vh`, `%`) are resolved against the current
 * window and re-computed on resize, so the chat scales with the page.
 */
export type ChatDimension = number | string;

export type ChatSize =
  | ChatSizePreset
  | { width: ChatDimension; height: ChatDimension };

// ============================================================================
// Hook Return Types
// ============================================================================

export interface UseAiChatReturn {
  messages: ChatMessage[];
  send: (message: string) => void;
  stop: () => void;
  isLoading: boolean;
  error: Error | null;
  loadMore: () => void;
  hasMore: boolean;
  clear: () => void;
  pipelineSteps: PipelineStepReport[];
  pipelineState: PipelineState | null;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  messageId: string;
  /** Human-readable description of what the tool will do */
  description?: string;
  /** Detail lines (e.g. "Title: My Task", "Priority: High") */
  details?: string[];
  /** Items of array-valued detail lines, by index into `details`. */
  detailItems?: Array<string[] | undefined>;
  /** Confirm button text override */
  confirmText?: string;
  /**
   * The ids of the call with the name this conversation showed for each
   * (`approvalSubjects`). Display only: the approved arguments are `args`.
   */
  subjects?: ApprovalSubject[];
  /**
   * What an approved call would do, as the server's preview source answered
   * (`data-approval-subjects`), labels in the chat's language. Looked-up,
   * untrusted values: plain text only. Absent without a server preview.
   * The values show the state when the approval was requested; they are
   * not rechecked when the approved call runs.
   */
  preview?: ApprovalPreviewItem[];
  /** `unchecked`: the server could not load the preview (no `preview` values; the card shows a note). */
  previewCheck?: 'found' | 'unchecked';
}

/** One shown value of a server preview. */
export interface ApprovalPreviewItem {
  /** The result path the value was read from (`impact.devices`). */
  key: string;
  /** The label in the chat's language. */
  label: string;
  value: string | number | boolean;
  format?: ApprovalPreviewFormat;
}

/**
 * One id of a pending tool call and what the browser's own message history
 * showed for it. Client-side data, so a convenience, never a trust boundary.
 */
export interface ApprovalSubject {
  /** Argument path (`id`, `playlist.id`, `items[].productId`). */
  path: string;
  /** Entity from the key or a mention (`Playlist`); absent for a bare `id` of unknown type. */
  label?: string;
  /** The id exactly as the call carries it. */
  id: string;
  /**
   * `named`: one name shown; `ambiguous`: different names for a non-UUID id,
   * or a non-UUID id seen for records of more than one kind (user 3 and
   * playlist 3) when the argument does not pick one of them (then without
   * `name`, with `candidates`); `seen`: no name, but a tool result of this
   * conversation carried the id as a record id (no warning); `unknown`: the
   * id occurred nowhere (warning).
   */
  status: 'named' | 'ambiguous' | 'seen' | 'unknown';
  /** The most recent name shown for the id; absent for an id seen for records of different kinds. */
  name?: string;
  /** All names shown for an ambiguous id, most recent first. */
  names?: string[];
  /**
   * Set for an id seen for records of different kinds that the argument
   * does not pick one of: every candidate record, most recent kind first,
   * with the kind as a label (`User`, `Playlist`, from the field or tool that
   * returned it) and its name when it had one. Show them all; name none.
   */
  candidates?: Array<{ label: string; name?: string }>;
  /**
   * For `seen`: a short field of the record that stands in for its name
   * (`Version number 3`, from `versionNumber`, `version`, `number`, `code` or
   * `slug`), when it has one.
   *
   * @deprecated Use `fallbackField` with the record's value for a localised
   * text; still filled.
   */
  fallback?: string;
  /** For `seen`: the declared fallback field the text came from (`versionNumber`). Only with a declaration. */
  fallbackField?: string;
  /** The declared type of the record the argument names (`inputEntities`). */
  type?: string;
  /** What the call does with that record (`inputEntities`): `target`, `parent` or `reference`. */
  role?: 'target' | 'parent' | 'reference';
  /**
   * `speaking`: a key the user types (order number, ticket key); an
   * `unknown` speaking id gets no warning. Only with a declaration.
   */
  idKind?: 'opaque' | 'speaking';
  /**
   * Where the id came from (declared arguments only): a tool result of this
   * conversation, an `@` mention, or typed verbatim in a user message (then
   * `seen`, no warning).
   */
  provenance?: 'tool-result' | 'mention' | 'user-message';
  /**
   * Where the name and status come from: `server` (looked up through the
   * tool's declared read source, `data-approval-subjects`) or `history` (the
   * browser's own message history). Absent = history; set explicitly on every
   * subject of a call the server sent subjects for.
   */
  source?: 'server' | 'history';
  /** The id by field (one entry, or one per part of a composite key). Only from the server. */
  ids?: Record<string, string>;
  /** For `seen`: the value of `fallbackField` (`3`), for a localised text. Only from the server. */
  fallbackValue?: string | number;
  /** The call's server preview, on its first `target` subject from the server. */
  preview?: ApprovalPreviewItem[];
  /**
   * Only from the server: `found` (the record exists), or `unchecked` (it
   * could not be checked right now, see `reason`; the card warns, distinct
   * from an unknown id). With `unchecked`, `source: 'history'` means the name
   * and status shown are the browser's fallback.
   */
  check?: 'found' | 'unchecked';
  /** Why the server could not check the record (`check: 'unchecked'`). */
  reason?: ApprovalSubjectUncheckedReason;
}

export interface UseApprovalsReturn {
  pending: PendingApproval[];
  approve: (id: string) => void;
  reject: (id: string) => void;
  grouped: Map<string, PendingApproval[]>;
  approveGroup: (toolName: string) => void;
  rejectGroup: (toolName: string) => void;
  isProcessing: boolean;
}

export interface UseMentionsReturn {
  query: string;
  results: MentionResult[];
  select: (result: MentionResult) => void;
  activeMentions: MentionData[];
  isSearching: boolean;
}

export interface UseSuggestionsReturn {
  chips: string[];
  refresh: () => void;
  select: (suggestion: string) => void;
  isGenerating: boolean;
}

// ============================================================================
// Component Props
// ============================================================================

export interface AiChatPanelProps {
  className?: string;
  defaultOpen?: boolean;
  /**
   * Ephemeral assistant greeting shown only when the current session
   * has no messages. Purely presentational — never persisted. Disappears
   * the moment the user (or the agent) adds a real message.
   *
   * Use case: dashboards that want a "press button → chat opens with
   * a prompt" affordance without polluting the session history when
   * the user closes the window without sending anything.
   */
  welcomeMessage?: string;
}

export interface MessageListProps {
  className?: string;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  className?: string;
  /** The recorded outcome of the message's turn, passed by `MessageList` when there is one. */
  turnOutcome?: TurnOutcome | null;
}

export interface ChatInputProps {
  className?: string;
  onSubmit?: (message: string) => void;
}

export interface MentionInputProps {
  className?: string;
  onSubmit?: (message: string) => void;
  /** Text put into the editor once on mount, after `initialMentions`. */
  initialValue?: string;
  /** References the editor starts with; key the input to start over (`key={taskId}`). */
  initialMentions?: MentionData[];
  /** Class of the box around editor, placeholder and list. */
  inputClassName?: string;
  /** Class of the editable element. */
  editorClassName?: string;
  /** Suggestion item; wins over `components.MentionDropdownItem` of the provider. */
  components?: RichMentionInputComponents;
  /** Extra controls between the editor and the send button, e.g. the app's own microphone. */
  renderActions?: (composer: ChatComposerInputControls) => ReactNode;
  /** Replaces the default send and stop buttons; a `type="submit"` button sends. */
  renderSubmit?: (composer: ChatComposerInputControls) => ReactNode;
}

export interface UseChatComposerInputOptions {
  /** Called instead of `send`; the composer clears afterwards. `files` only when something is attached. */
  onSubmit?: (message: string, mentions: MentionData[], files?: FilePart[]) => void;
  /** Text put into the editor once on mount, after the input's `initialMentions`. */
  initialValue?: string;
}

export interface ChatComposerInputControls {
  /** Current text including `@`/`/` tokens. */
  readonly value: string;
  readonly isLoading: boolean;
  /** Non-blank text or an attachment, and not loading. */
  readonly canSend: boolean;
  /** Files waiting to be sent with the next message. */
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Last refusal of a file or of a send with files, localized; null when none. */
  readonly attachmentError: string | null;
  /** Whether the provider enables attachments. */
  readonly attachmentsEnabled: boolean;
  /** Reads, checks and adds files (paste, drop, picker). */
  addFiles(files: FileList | ReadonlyArray<File>): Promise<void>;
  removeAttachment(id: string): void;
  /** Opens the file picker of `attachmentInputProps`. */
  openFilePicker(): void;
  /** Sends the editor text with its structured mentions; false when nothing was taken (the text stays). */
  submit(): boolean;
  stop(): void;
  /** Replaces the text; references whose token is not in it are dropped. */
  setText(text: string): void;
  /** Appends with one space, e.g. a voice transcript; references stay. */
  appendText(text: string): void;
  focus(): void;
}

export interface ChatComposerInput extends ChatComposerInputControls {
  /** `<RichMentionInput ref={composer.inputRef} {...composer.inputProps} />` */
  readonly inputRef: RefObject<RichMentionInputHandle | null>;
  readonly inputProps: Pick<RichMentionInputProps,
    'onChange' | 'onSubmit' | 'onSearch' | 'onEntityAction' | 'placeholder' | 'disabled' | 'listLabel' | 'resultsLabel' | 'emptyLabel' | 'removeMentionLabel' | 'onFiles' | 'onBackspaceEmpty' | 'allowEmptySubmit' | 'triggers'>;
  /** Spread onto a hidden `<input>` rendered next to the editor; `openFilePicker` clicks it. */
  readonly attachmentInputProps: ChatAttachmentInputProps;
  readonly pendingCommand: PendingChatCommand | null;
  submitPendingCommand(values: Readonly<Record<string, string>>, valueLabels?: Readonly<Record<string, string>>): boolean;
  cancelPendingCommand(): void;
  /** The argument form (`components.CommandArgumentsForm` or the default), `null` when nothing is pending. */
  readonly argumentsForm: ReactNode;
}

export interface RichMentionInputHandle {
  focus: () => void;
  clear: () => void;
  getValue: () => string;
  /** Restore text, optionally retaining the ordered identities of its mention tokens. */
  setValue: (value: string, mentions?: MentionData[]) => void;
  getMentions: () => MentionData[];
  /** Puts a reference at the start of the editor (kept for existing callers; prefer `insertMention`). */
  addMention: (mention: MentionData) => void;
  /**
   * Puts a pill at the caret, or at the end when the caret is outside the
   * editor, and leaves the caret behind it. A `type: 'command'` mention
   * becomes a command pill, any other type an entity pill.
   */
  insertMention: (mention: MentionData) => void;
}

/** ARIA wiring of one option in the `@`/`/` list; spread it onto the clickable element. */
export interface MentionDropdownOptionProps {
  id: string;
  role: 'option';
  'aria-selected': boolean;
  tabIndex: -1;
}

export interface MentionDropdownItemProps {
  result: MentionResult;
  isSelected: boolean;
  onClick: () => void;
  /** Custom items must spread these onto their clickable element for keyboard and screen-reader use. */
  optionProps?: MentionDropdownOptionProps;
}

export interface RichMentionInputComponents {
  DropdownItem?: ComponentType<MentionDropdownItemProps>;
}

export interface RichMentionInputProps {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Class of the wrapper in mention mode (plain mode has none; there `className` styles the element). */
  wrapperClassName?: string;
  /** Shown instead of the list when a search finds nothing; without it an empty result shows nothing. */
  emptyLabel?: string;
  onChange?: (nextValue: string) => void;
  /** Receives the text and the structured mentions (chips and commands) still in it. Return `false` to keep the text. */
  onSubmit?: (message: string, mentions: MentionData[]) => void | boolean;
  /** Search callback for mention autocomplete (BYOS). Return matching results for the given query and trigger character. */
  onSearch?: (query: string, trigger: string) => Promise<MentionResult[]> | MentionResult[];
  /** Mention data to render as inline chips on mount (e.g. pre-filled context from a detail view). */
  initialMentions?: MentionData[];
  /**
   * Characters that open the autocomplete dropdown. Defaults to `['@', '/']`.
   * An entry can be a definition to set the pill prefix (default: the char).
   */
  triggers?: ReadonlyArray<string | ChatTriggerDefinition>;
  /** Component overrides for the autocomplete dropdown. */
  components?: RichMentionInputComponents;
  /** An entity action picked next to a result (mouse, or ArrowRight then Enter). */
  onEntityAction?: (result: MentionResult, actionId: string) => void;
  /** Accessible name of the suggestion list. Default `Suggestions`. */
  listLabel?: string;
  /** Announced result count; `{count}` is replaced. Default `{count} suggestions`. */
  resultsLabel?: string;
  /**
   * A picked `/` command becomes a pill like an `@` entity (default). `false`
   * keeps the earlier behaviour: the command is inserted as `/slug ` text.
   */
  commandPills?: boolean;
  /** Accessible name of a pill's remove control; `{label}` is replaced. Default `Remove {label}`. */
  removeMentionLabel?: string;
  /** Pasted or dropped files. Without it the editor ignores files and drops. */
  onFiles?: (files: File[]) => void;
  /** Backspace in an empty editor, e.g. to remove the last attachment. */
  onBackspaceEmpty?: () => void;
  /** Enter submits an empty editor, e.g. while attachments wait. */
  allowEmptySubmit?: boolean;
}

export interface ChatWindowHeaderRenderProps {
  /** Insert these controls in a custom header when layoutControls is enabled. */
  layoutControls?: ReactNode;
  onClose: () => void;
  isDragging: boolean;
  onDragStart: (e: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

export interface ChatWindowProps {
  children: ReactNode;
  title?: string;
  /** Aria-label + tooltip for the default close button. */
  closeChatAriaLabel?: string;
  header?: ReactNode;
  /**
   * Extra nodes rendered between the title and the close button in the
   * default header. Ignored when `renderHeader` is provided.
   */
  headerActions?: ReactNode;
  /**
   * Replace the title node in the default header — e.g. to render a
   * session switcher dropdown. Ignored when `renderHeader` is provided.
   */
  headerTitle?: ReactNode;
  renderHeader?: (props: ChatWindowHeaderRenderProps) => ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  /** Keep this stable across mode changes. false reserves space in the host
   * flex row for a sidebar; true renders an overlay in document.body. */
  portal?: boolean;
  mode?: 'floating' | 'sidebar';
  defaultMode?: 'floating' | 'sidebar';
  onModeChange?: (mode: 'floating' | 'sidebar') => void;
  /** Opt into common dock/float/collapse buttons. Default false. */
  layoutControls?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Initial sidebar width; changed props resize it. Echoing onSidebarWidthChange
   * into this prop is supported. Floating width/height remain independent. */
  sidebarWidth?: number;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  layoutLabels?: Partial<Record<'dock' | 'float' | 'collapse' | 'expand' | 'resize', string>>;
  open?: boolean;
  /** Preserve child state while closed. Hidden content is inert; consumers must
   * stop owned media and dismiss external portals when closing. Default false. */
  keepMounted?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  draggable?: boolean;
  resizable?: boolean;
  constrainToViewport?: boolean;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  initialPosition?: { x: number; y: number };
  maxWidth?: number;
  maxHeight?: number;
  snapToCenter?: boolean;
  snapRadius?: number;
  edgeThreshold?: number;
  persistDimensions?: boolean | string;
  /** Set false when the app persists sidebarWidth itself. Floating dimension
   * persistence remains enabled. Default true. */
  persistSidebarWidth?: boolean;
  onPositionChange?: (pos: { x: number; y: number } | null) => void;
  onDimensionChange?: (size: { width: number; height: number }) => void;
  resizeHandleClassName?: string;
  snapIndicatorClassName?: string;
}

export interface ApprovalCardProps {
  approval: PendingApproval;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  className?: string;
  isProcessing?: boolean;
}

export interface BulkApprovalCardProps {
  toolName: string;
  approvals: PendingApproval[];
  onApproveAll: () => void;
  onRejectAll: () => void;
  className?: string;
  isProcessing?: boolean;
}

export interface PipelineTimelineProps {
  steps: PipelineStepReport[];
  pipelineState: PipelineState | null;
  isLoading: boolean;
  onStop: () => void;
  className?: string;
}

export interface SuggestionChipProps {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  isVisible?: boolean;
}

export interface SuggestionBarProps {
  className?: string;
}

export interface ClarificationCardProps {
  toolCallId: string;
  request: ClarificationRequest;
  /** False once answered or when a newer message exists. */
  interactive: boolean;
  onAnswer: (answer: { text: string; optionId?: string }) => void;
  className?: string;
}

export interface ToolResultBlockProps {
  toolName: string;
  result: unknown;
  className?: string;
}

export interface MarkdownProps {
  content: string;
  className?: string;
}

export interface AttachmentTrayProps {
  attachments: ReadonlyArray<ChatAttachment>;
  onRemove: (id: string) => void;
  /** Announced in a polite live region. */
  error?: string | null;
  className?: string;
}

export interface AttachmentButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export interface MentionChipProps {
  mention: Mention;
  onRemove?: () => void;
  /** Makes the pill a button that opens the entity (see `entityLinks`). */
  onOpen?: () => void;
  /** Accessible name of the open button; defaults to the display name. */
  openLabel?: string;
  className?: string;
  compact?: boolean;
  inline?: boolean;
}

export interface MentionChipListProps {
  mentions: Mention[];
  onRemove?: (mentionId: string) => void;
  className?: string;
}

// ============================================================================
// AI Trigger Button
// ============================================================================

export interface AiTriggerButtonProps {
  /** Called when the main button area (Sparkles) is clicked */
  onClickChat: () => void;
  /** Called when the mic button is clicked */
  onClickMic: () => void;
  /** Whether voice is currently recording */
  isRecording?: boolean;
  /** Whether voice connection is being established */
  isConnecting?: boolean;
  /** The single authoritative stream owned by the STT controller */
  recordingStream?: MediaStream | null;
  /** Live final plus interim transcript shown while recording */
  recordingTranscript?: string;
  /** Called when user stops recording (red circle) */
  onStopRecording?: () => void;
  /** Called when user cancels recording (X) */
  onCancelRecording?: () => void;
  /** Render portal into document.body. Default: true */
  portal?: boolean;
  /** Optional className override for the outer fixed container */
  className?: string;
  /** Optional className for the button pill itself (e.g. `ai-magic-button`) */
  buttonClassName?: string;
  /** Wrap the default-state button in custom chrome (ContextMenu, Tooltip, etc.) */
  renderWrapper?: (button: ReactElement) => ReactElement;
  /** Allow the button to be dragged to a custom position. Default: true */
  draggable?: boolean;
  /** SessionStorage key for persisting the dragged position. Set to false to disable. Default: 'ai-trigger-btn' */
  persistPosition?: string | false;
  /** ARIA label for the main button. Default: "AI Assistant" */
  ariaLabel?: string;
  /** ARIA label for the mic button. Default: "Start recording" */
  micAriaLabel?: string;
  /** ARIA label for stop recording. Default: "Stop recording" */
  stopAriaLabel?: string;
  /**
   * Render the mic zone on the pill. Default: `true`. Set to `false`
   * to render a single-icon trigger (just the sparkle / custom icon).
   */
  showMic?: boolean;
  /**
   * Replace the built-in sparkle with a custom icon node. Sized to
   * ~16×16 visually but can be anything (img, SVG, emoji, etc.).
   */
  icon?: ReactNode;
  /** ARIA label for cancel recording. Default: "Cancel recording" */
  cancelAriaLabel?: string;
}

/** Options the host passes to the default Markdown renderer. */
export interface ChatMarkdownOptions {
  /** remark plugins, e.g. `remark-gfm` (installed by the host, not by glirastes). */
  remarkPlugins?: ReadonlyArray<unknown>;
}
