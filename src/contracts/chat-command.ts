/**
 * Wire protocol of direct chat commands: a `/` command or an entity action
 * the user runs without a model call. The chat UI sends it as the complete
 * text of a user message; the chat handler runs the named tool through the
 * normal tool path (authorization, confirmation, revocation, budget, audit).
 * Dependency-free like `clarification.ts`, so the React bundle,
 * `<glirastes-chat>` and the server adapters share it.
 */

/** Command and action ids: a letter or digit, then `[A-Za-z0-9._-]`, at most 200 characters. */
export const CHAT_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Catalog definition ids, e.g. `ui.navigate` or `tasks.update`. */
export const CHAT_COMMAND_TOOL_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
/** Serialized JSON of the arguments, after escaping. */
export const CHAT_COMMAND_MAX_ARGS_LENGTH = 2_000;
export const CHAT_COMMAND_MAX_LABEL_LENGTH = 200;
/**
 * Longest message text read as a command. A formatted command is below 2,700
 * characters (marker payload at most 2,434, framing about 30, label at most
 * 200); the parser sees unauthenticated, unbounded user text before any
 * guardrail runs, so anything longer is not parsed at all.
 */
export const CHAT_COMMAND_MAX_MESSAGE_LENGTH = 4_096;
/** Tool call ids of direct commands start with this prefix. */
export const CHAT_COMMAND_TOOL_CALL_PREFIX = 'glirastes-command-';

export interface ChatCommandInvocation {
  readonly commandId: string;
  /** Catalog definition id of the tool to run. */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ParsedChatCommandMessage {
  readonly invocation: ChatCommandInvocation;
  /** The visible line after the marker, trimmed (may be empty). */
  readonly label: string;
}

// No trailing `\s*`: it overlaps `[^\n]*` and backtracks quadratically on a padded label.
// `parseChatCommandMessage` trims the end of the text first instead.
const MARKER = /^\s*<!--glirastes:command (\{[^\n]{2,2600}\})-->(?:\n([^\n]*))?$/;
const MARKERS = /<!--glirastes:command \{[^\n]{0,2600}?\}-->[ \t]*\n?/g;
const KEYS = new Set(['commandId', 'tool', 'args']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON of `args` with `<` and `>` escaped, so it can never close the marker
 * comment, or `undefined` when it is not a plain object or too long.
 */
export function serializeChatCommandArgs(args: unknown): string | undefined {
  if (!isPlainObject(args)) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  const safe = json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return safe.length <= CHAT_COMMAND_MAX_ARGS_LENGTH ? safe : undefined;
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, CHAT_COMMAND_MAX_LABEL_LENGTH);
}

/**
 * The user message that runs a command without a model call:
 * `<!--glirastes:command {"commandId":…,"tool":…,"args":{…}}-->` and the
 * visible label on the next line. Throws on an id, tool or argument set the
 * server would refuse.
 */
export function formatChatCommandMessage(input: {
  commandId: string;
  tool: string;
  args?: Readonly<Record<string, unknown>>;
  label: string;
}): string {
  if (!CHAT_COMMAND_ID_PATTERN.test(input.commandId)) throw new Error('Invalid chat command id');
  if (!CHAT_COMMAND_TOOL_PATTERN.test(input.tool)) throw new Error('Invalid chat command tool');
  const args = serializeChatCommandArgs(input.args ?? {});
  if (args === undefined) {
    throw new Error(`Chat command arguments must be a JSON object of at most ${CHAT_COMMAND_MAX_ARGS_LENGTH} characters`);
  }
  const payload = `{"commandId":${JSON.stringify(input.commandId)},"tool":${JSON.stringify(input.tool)},"args":${args}}`;
  return `<!--glirastes:command ${payload}-->\n${cleanLabel(input.label)}`;
}

/**
 * Reads a message that consists of exactly one command marker (and its
 * label line). Anything else, including a malformed or oversized payload or
 * a message longer than `CHAT_COMMAND_MAX_MESSAGE_LENGTH`, is not a command.
 */
export function parseChatCommandMessage(text: string): ParsedChatCommandMessage | undefined {
  if (text.length > CHAT_COMMAND_MAX_MESSAGE_LENGTH) return undefined;
  const match = MARKER.exec(text.trimEnd());
  if (!match) return undefined;
  const payload = match[1]!;
  if (/[<>]/.test(payload)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isPlainObject(record) || Object.keys(record).some((key) => !KEYS.has(key))) return undefined;
  const { commandId, tool, args } = record;
  if (typeof commandId !== 'string' || !CHAT_COMMAND_ID_PATTERN.test(commandId)) return undefined;
  if (typeof tool !== 'string' || !CHAT_COMMAND_TOOL_PATTERN.test(tool)) return undefined;
  if (serializeChatCommandArgs(args) === undefined) return undefined;
  return {
    invocation: { commandId, tool, args: args as Record<string, unknown> },
    label: cleanLabel(match[2] ?? ''),
  };
}

/** Removes every command marker, e.g. for display or for the model's copy of old messages. */
export function stripChatCommandMarkers(text: string): string {
  return text.replace(MARKERS, '');
}

/**
 * A tool call id of a direct command: the prefix, then only characters every
 * model provider accepts in a tool call id (later model turns replay it).
 */
export function isChatCommandToolCallId(toolCallId: unknown): toolCallId is string {
  return typeof toolCallId === 'string'
    && toolCallId.startsWith(CHAT_COMMAND_TOOL_CALL_PREFIX)
    && /^[A-Za-z0-9_-]{1,64}$/.test(toolCallId);
}
