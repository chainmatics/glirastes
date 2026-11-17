import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { PrivacyError } from './detection-result.js';
import type { PrivacySession } from './strict-shield.js';

/**
 * Server-side provenance of chat history in the protected profile.
 *
 * The browser keeps the conversation and sends it back each turn. History
 * goes to a model again only when this server bound it, in the current
 * mapping generation, as exactly that message at exactly that place:
 *
 * - A binding covers one whole message: its role and its parts in order,
 *   with every tool call together with its own result. It is chained to the
 *   binding of the message before it, so known messages cannot be re-roled,
 *   reordered, duplicated, spliced or recombined, and a client text cannot
 *   gain assistant or tool origin by reusing a known text.
 * - Bindings are keyed digests over scope, generation id and that canonical
 *   form (`PrivacyMappingStore.bind`); a client cannot produce one. Message
 *   ids are not evidence and not part of a binding.
 * - The newest user message is new input: it goes through the full
 *   protection path and is then bound. Each answer is bound with the parts
 *   the server released to the response stream (not proof that the browser
 *   received them), replayed with the AI SDK's own UI message reducer.
 *
 * What is not bound (an earlier generation after expiry, a lost or purged
 * mapping, a changed or unknown message) is withheld from the model, which
 * gets a notice instead; the browser keeps showing it. A continuation
 * (approval answer) whose message is not bound is refused with
 * `privacy_mapping_expired`, so an approval or tool call of an earlier
 * generation never runs again. Binding is protection against manipulation;
 * it replaces neither detection nor the model-egress checks.
 */

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

type Part = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolPart(part: Part): boolean {
  const type = typeof part.type === 'string' ? part.type : '';
  return type === 'dynamic-tool' || type.startsWith('tool-');
}

/**
 * Files never go to a model as history (only the newest user message may
 * carry one, checked by the screenshot rule), and the browser strips file
 * data from older turns: they are outside the binding.
 */
function isFilePart(part: Part): boolean {
  return part.type === 'file';
}

const RESOLVED_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied']);

function withDefined(record: Record<string, unknown>): Part {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * The fields of a tool part the AI SDK turns into model input
 * (`convertToModelMessages`), and nothing else. An open approval keeps only
 * its id, except in the message a continuation answers: that answer is new
 * input, verified by the approval binder.
 */
function projectToolPart(part: Part, answering: boolean): Part {
  const resolved = RESOLVED_TOOL_STATES.has(part.state as string);
  const approval = isRecord(part.approval)
    ? withDefined(resolved || answering
      ? { id: part.approval.id, approved: part.approval.approved, reason: part.approval.reason }
      : { id: part.approval.id })
    : undefined;
  const state = !resolved && !answering && part.state === 'approval-responded' ? 'approval-requested' : part.state;
  return withDefined({
    type: part.type,
    ...(part.type === 'dynamic-tool' ? { toolName: part.toolName } : {}),
    toolCallId: part.toolCallId,
    state,
    input: part.input,
    ...(state === 'output-available' ? { output: part.output, preliminary: part.preliminary } : {}),
    ...(state === 'output-error' ? { errorText: part.errorText, rawInput: part.rawInput } : {}),
    providerExecuted: part.providerExecuted,
    callProviderMetadata: part.callProviderMetadata,
    ...(resolved ? { resultProviderMetadata: part.resultProviderMetadata } : {}),
    approval,
  });
}

/**
 * The part as a model may receive it: exactly the fields the binding
 * covers, so a field the client adds or changes outside the binding never
 * reaches a model. `undefined` for a part outside history (a file).
 */
function projectPart(part: unknown, answering: boolean): Part | undefined {
  if (!isRecord(part)) return { type: 'invalid' };
  if (isFilePart(part)) return undefined;
  const type = typeof part.type === 'string' ? part.type : '';
  if (type === 'step-start') return { type };
  if (type === 'text' || type === 'reasoning') return withDefined({ type, text: part.text, providerMetadata: part.providerMetadata });
  if (type === 'source-url') {
    return withDefined({ type, sourceId: part.sourceId, url: part.url, title: part.title, providerMetadata: part.providerMetadata });
  }
  if (type === 'source-document') {
    return withDefined({
      type, sourceId: part.sourceId, mediaType: part.mediaType, title: part.title, filename: part.filename, providerMetadata: part.providerMetadata,
    });
  }
  if (type.startsWith('data-')) return withDefined({ type, id: part.id, data: part.data });
  if (isToolPart(part)) return projectToolPart(part, answering);
  // A part type this module does not know: kept and bound as a whole, without its state.
  const { state: _state, ...rest } = part;
  return rest;
}

/** The bound form of one projected part. */
function canonicalPart(part: Part): unknown {
  if (!isToolPart(part)) return part;
  const resolved = RESOLVED_TOOL_STATES.has(part.state as string);
  const approval = isRecord(part.approval) ? part.approval : undefined;
  return [
    'tool', part.type, part.toolName ?? null, part.toolCallId ?? null, part.input ?? null,
    // A call without a result yet (input-streaming, input-available,
    // approval-requested, approval-responded) is one state: the answer to an
    // approval is checked by the approval binder, not here.
    resolved
      ? [part.state, part.output ?? null, part.preliminary === true, part.errorText ?? null, part.rawInput ?? null, part.resultProviderMetadata ?? null]
      : ['pending'],
    part.providerExecuted ?? null, part.callProviderMetadata ?? null,
    approval ? (resolved ? [approval.id ?? null, approval.approved ?? null, approval.reason ?? null] : [approval.id ?? null]) : null,
  ];
}

/** A message as a model may receive it: id, role and projected parts only. */
function projectMessage(message: unknown, answering = false): Record<string, unknown> {
  const record = isRecord(message) ? message : {};
  const parts = Array.isArray(record.parts) ? record.parts : [];
  return {
    id: record.id,
    role: record.role,
    parts: parts.map((part) => projectPart(part, answering)).filter((part): part is Part => part !== undefined),
  };
}

/** Canonical form of a message at its place in the conversation. */
export function canonicalMessage(previous: string | null, message: unknown): string {
  const projected = projectMessage(message);
  return canonicalJson(['glirastes-chat-message/v1', previous, projected.role ?? null,
    (projected.parts as Part[]).map(canonicalPart)]);
}

/** The newest user message as a model may receive it: projected, files kept for the screenshot rule. */
function projectNewInput(message: unknown): Record<string, unknown> {
  const record = isRecord(message) ? message : {};
  const parts = Array.isArray(record.parts) ? record.parts : [];
  return {
    id: record.id,
    role: record.role,
    parts: parts.map((part) => isRecord(part) && isFilePart(part)
      ? withDefined({ type: 'file', mediaType: part.mediaType, filename: part.filename, url: part.url, providerMetadata: part.providerMetadata })
      : projectPart(part, false)).filter((part): part is Part => part !== undefined),
  };
}

/** The text parts of the newest user message: each goes through the full protection path before it is bound. */
export function newInputTexts(history: ProtectedHistory): string[] {
  if (!isRecord(history.newInput) || !Array.isArray(history.newInput.parts)) return [];
  return history.newInput.parts
    .filter((part): part is Part => isRecord(part) && (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string')
    .map((part) => part.text as string);
}

/**
 * The form `sanitizeStoredMessages` gives a stored message after a reload:
 * open approval requests removed, an emptied message dropped (`null`).
 */
function restoredForm(message: UIMessage): UIMessage | null | undefined {
  const parts = message.parts.filter((part) => !(isToolPart(part as Part) && (part as Part).state === 'approval-requested'));
  if (parts.length === message.parts.length) return undefined;
  return parts.length === 0 ? null : { ...message, parts };
}

export const HISTORY_WITHHELD_NOTICE = 'Hinweis: Frühere Nachrichten dieses Chats werden nicht mehr verwendet, weil ihre Datenschutz-Zuordnung abgelaufen ist. '
  + 'Gehe nicht davon aus, dass du sie kennst; bitte den Nutzer, relevante Angaben erneut zu nennen. / '
  + 'Note: earlier messages of this chat are no longer used because their privacy mapping expired. '
  + 'Do not assume you know them; ask the user to provide relevant details again.';

/** Text for the UI when earlier messages were withheld from the model. */
export function historyWithheldNotice(locale?: string): string {
  return locale?.toLowerCase().startsWith('en')
    ? 'Earlier messages of this chat are no longer used by the assistant. Please provide relevant details again.'
    : 'Frühere Nachrichten dieses Chats werden vom Assistenten nicht mehr verwendet. Bitte relevante Angaben erneut nennen.';
}

export interface ProtectedHistory {
  /** What the model may receive: a notice (when something was withheld), the bound history, the new input. */
  messages: unknown[];
  /** Number of earlier messages withheld from the model; the browser still shows them. */
  withheldMessages: number;
  /** The binding the next message of this turn attaches to. */
  anchor: string | null;
  /** The assistant message a continuation (approval answer) appends to. */
  continued: UIMessage | undefined;
  /** The newest user message, when the request brings new input. */
  newInput: unknown;
}

/**
 * Selects the history a protected turn may send to a model: the longest
 * chain of bound messages that ends right before the newest user message
 * (or, for a continuation, with the continued assistant message).
 */
export function protectedHistory(messages: ReadonlyArray<unknown>, session: PrivacySession): ProtectedHistory {
  const latest = messages.at(-1);
  const role = isRecord(latest) ? latest.role : undefined;
  if (latest !== undefined && role !== 'user' && role !== 'assistant') throw new PrivacyError('privacy_unsupported_content');
  const newInput = role === 'user';
  const history = newInput ? messages.slice(0, -1) : messages;
  let run: Array<{ message: unknown; digest: string }> = [];
  let withheld = 0;
  for (const message of history) {
    const previous = run.at(-1)?.digest ?? null;
    const linked = canonicalMessage(previous, message);
    if (previous !== null && session.isBound(linked)) {
      run.push({ message, digest: session.bindingDigest(linked) });
      continue;
    }
    // A message the server bound as the start of the model context, after
    // everything before it had been withheld.
    const start = canonicalMessage(null, message);
    if (session.isBound(start)) {
      withheld += run.length;
      run = [{ message, digest: session.bindingDigest(start) }];
      continue;
    }
    withheld += run.length + 1;
    run = [];
  }
  let continued: UIMessage | undefined;
  let anchor = run.at(-1)?.digest ?? null;
  if (!newInput && latest !== undefined) {
    if (run.at(-1)?.message !== latest) throw new PrivacyError('privacy_mapping_expired');
    continued = latest as UIMessage;
    anchor = run.at(-2)?.digest ?? null;
  }
  // The model receives the projection the binding covers, never the client's object.
  const kept = run.map(({ message }) => projectMessage(message, message === continued));
  if (newInput) kept.push(projectNewInput(latest));
  return {
    messages: withheld > 0
      ? [{ id: 'glirastes-privacy-history-withheld', role: 'user', parts: [{ type: 'text', text: HISTORY_WITHHELD_NOTICE }] }, ...kept]
      : kept,
    withheldMessages: withheld,
    anchor,
    continued,
    newInput: newInput ? latest : undefined,
  };
}

/** Binds the newest user message after it passed the protection path; returns the anchor for the answer. */
export async function bindNewInput(session: PrivacySession, history: ProtectedHistory): Promise<string | null> {
  if (history.newInput === undefined) return history.anchor;
  const canonical = canonicalMessage(history.anchor, history.newInput);
  await session.bind([canonical]);
  return session.bindingDigest(canonical);
}

/** Canonical forms to bind for an answer as the server released it. */
export function answerBindings(anchor: string | null, answer: UIMessage): string[] {
  const out = [canonicalMessage(anchor, answer)];
  const restored = restoredForm(answer);
  if (restored) out.push(canonicalMessage(anchor, restored));
  return out;
}

/**
 * Passes an SSE UI message stream response through unchanged and, when it
 * ends or is cancelled, binds the answer as built from the chunks released
 * so far. Binding finishes before the response body closes, so the next
 * request sees it. A failed bind costs context only: the next turn withholds
 * what is not bound.
 */
/** Largest answer (SSE text) the server replays to bind it. */
export const MAX_BOUND_ANSWER_CHARS = 4 * 1024 * 1024;

export function sealProtectedResponse(
  response: Response,
  session: PrivacySession,
  options: { anchor: string | null; continued?: UIMessage; onBindFailed?: (error: unknown) => void },
): Response {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || !contentType.includes('text/event-stream')) return response;
  let chunks!: ReadableStreamDefaultController<UIMessageChunk>;
  const chunkStream = new ReadableStream<UIMessageChunk>({ start(controller) { chunks = controller; } });
  let reducerFailed = false;
  const snapshots = readUIMessageStream({
    ...(options.continued ? { message: structuredClone(options.continued) } : {}),
    stream: chunkStream,
    // An error chunk, or a chunk the reducer cannot apply, affects the
    // browser's copy the same way: the snapshot stays what it received.
    onError: () => undefined,
  });
  const final = (async () => {
    let last: UIMessage | undefined;
    for await (const snapshot of snapshots) last = snapshot;
    return last;
  })().catch(() => {
    reducerFailed = true;
    return undefined;
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let released = 0;
  const feed = (text: string) => {
    if (reducerFailed) return;
    // The reducer copies the message per chunk: a very long answer is not
    // bound (it costs context in the next turn, never protection).
    released += text.length;
    if (released > MAX_BOUND_ANSWER_CHARS) {
      reducerFailed = true;
      buffer = '';
      return;
    }
    buffer += text;
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          chunks.enqueue(JSON.parse(payload) as UIMessageChunk);
        } catch {
          reducerFailed = true;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  };

  let finished: Promise<void> | undefined;
  const finish = () => {
    finished ??= (async () => {
      feed(`${decoder.decode()}\n\n`);
      chunks.close();
      const answer = await final;
      if (!answer || reducerFailed || answer.parts.length === 0) return;
      try {
        await session.bind(answerBindings(options.anchor, answer));
      } catch (error) {
        options.onBindFailed?.(error);
      }
    })();
    return finished;
  };

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        await finish();
        controller.error(error);
        return;
      }
      if (next.done) {
        await finish();
        controller.close();
        return;
      }
      feed(decoder.decode(next.value, { stream: true }));
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      // Stop the model and tools at once; bind what was released meanwhile.
      await Promise.all([reader.cancel(reason).catch(() => undefined), finish()]);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
