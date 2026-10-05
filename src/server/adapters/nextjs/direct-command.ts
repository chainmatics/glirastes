import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import {
  CHAT_COMMAND_TOOL_CALL_PREFIX,
  isChatCommandToolCallId,
  parseChatCommandMessage,
  stripChatCommandMarkers,
  type ChatCommandInvocation,
} from '../../../contracts/chat-command.js';
import { createAiSdkTools } from '../../../runtime/ai-sdk/engine.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import type { ManagedTurnGuard } from '../../../runtime/managed-turn.js';
import { UNKNOWN_TURN_COST } from '../../../runtime/metrics/cost.js';
import type { TurnMetricsRecorder } from '../../../runtime/metrics/turn-recorder.js';
import type { ToolRegistry } from '../../../types.js';
import { NON_DOMAIN_TOOL_NAMES } from './tool-discovery.js';

/** A direct command in the latest user message, and where its turn stands. */
export interface DirectCommandRequest {
  readonly invocation: ChatCommandInvocation;
  readonly label: string;
  /** The user's answer to this command's confirmation request. */
  readonly approval?: {
    readonly toolCallId: string;
    readonly approved: boolean;
  };
  /** The command already ran or was refused; nothing is left to do. */
  readonly settled?: boolean;
}

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(message: MessageRecord): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part): part is MessageRecord => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * Reads the latest user message as a direct command. The assistant message
 * that follows it (an approval continuation) decides whether the command
 * still waits for its confirmation answer or is settled.
 */
export function resolveDirectCommand(messages: ReadonlyArray<unknown>): DirectCommandRequest | undefined {
  let index = messages.length - 1;
  while (index >= 0 && !(isRecord(messages[index]) && (messages[index] as MessageRecord).role === 'user')) index -= 1;
  if (index < 0) return undefined;
  const parsed = parseChatCommandMessage(textOf(messages[index] as MessageRecord));
  if (!parsed) return undefined;
  const next = messages[index + 1];
  if (next === undefined) return parsed;
  const parts = isRecord(next) && next.role === 'assistant' && Array.isArray(next.parts) ? next.parts : [];
  const call = parts.find((part): part is MessageRecord => isRecord(part) && isChatCommandToolCallId(part.toolCallId));
  if (call?.state === 'approval-responded' && isRecord(call.approval)) {
    return { ...parsed, approval: { toolCallId: call.toolCallId as string, approved: call.approval.approved === true } };
  }
  return { ...parsed, settled: true };
}

/** The model's copy of the history: earlier command markers removed, the visible label kept. */
export function stripChatCommandMessages(messages: ReadonlyArray<unknown>): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== 'user') return message;
    if (typeof message.content === 'string') {
      const content = stripChatCommandMarkers(message.content);
      return content === message.content ? message : { ...message, content };
    }
    if (!Array.isArray(message.parts)) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') return part;
      const text = stripChatCommandMarkers(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, parts } : message;
  });
}

/**
 * The registry key of the command's tool: the tool whose id is the
 * definition id, else the key spelled like it. SDK built-ins never run as
 * direct commands.
 */
export function resolveCommandToolName(registry: ToolRegistry, tool: string): string | undefined {
  const builtins = new Set<string>(NON_DOMAIN_TOOL_NAMES);
  const names = Object.keys(registry).filter((name) => !builtins.has(name));
  return names.find((name) => registry[name]!.id === tool)
    ?? names.find((name) => name === tool || name === modelFacingToolName(tool));
}

/** Content-free reason for the client: a denial code from the guard, never a backend message. */
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const denied = /^Tool execution denied: ([a-z_]{1,80})\b/.exec(message);
  if (denied) return denied[1]!;
  if (/ timed out after \d+ms$/.test(message)) return 'command_timeout';
  return 'command_failed';
}

function failedResult(result: unknown): boolean {
  return isRecord(result) && (typeof result.error === 'string' || result.success === false);
}

/**
 * 20 hex characters: the tool call id stays within 40 characters, the
 * shortest provider limit (OpenAI), because later model turns replay it.
 */
function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}

export interface RunDirectCommandOptions {
  command: DirectCommandRequest;
  /** The turn's registry, built exactly like for a model turn. */
  registry: ToolRegistry;
  /** `toolsToAiTools(registry, …)`, after the same wrappers as the model path. */
  tools: Record<string, unknown>;
  managedTurn?: ManagedTurnGuard;
  turnMetrics?: TurnMetricsRecorder;
  onError?: (error: unknown) => void;
  /** Suffix of the tool call and approval ids; default 20 random hex characters. */
  generateId?: () => string;
}

/**
 * Runs a direct command without a model call. The tool goes through the
 * same AI SDK wrapper as on the model path: input schema, the managed guard
 * (manifest, principal, roles, revocation, budget), confirmation
 * (`needsApproval` / the policy) and audit. A tool that needs confirmation
 * answers with an AI SDK approval request; the approval continuation runs
 * it. One content-free metric event per request: no model, unknown cost,
 * the executed call (or none) as tool count.
 */
export async function runDirectCommand(options: RunDirectCommandOptions): Promise<Response> {
  const { command, registry, managedTurn, turnMetrics } = options;
  const nextId = options.generateId ?? shortId;
  const name = resolveCommandToolName(registry, command.invocation.tool);
  const toolName = name ?? modelFacingToolName(command.invocation.tool);

  const record = (calls: number, failures: number) => {
    turnMetrics?.recordStep({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: UNKNOWN_TURN_COST,
      toolNames: calls > 0 ? [toolName] : [],
      failedToolNames: failures > 0 ? [toolName] : [],
    });
    turnMetrics?.finish({ status: 'completed', errorCode: null });
  };

  const stream = createUIMessageStream({
    onError: () => 'Command failed',
    execute: async ({ writer }) => {
      try {
        writer.write({ type: 'start' });
        if (command.settled) {
          writer.write({ type: 'finish' });
          record(0, 0);
          return;
        }
        const toolCallId = command.approval?.toolCallId ?? `${CHAT_COMMAND_TOOL_CALL_PREFIX}${nextId()}`;
        const fresh = command.approval === undefined;
        if (fresh) {
          writer.write({ type: 'start-step' });
          writer.write({ type: 'tool-input-available', toolCallId, toolName, input: command.invocation.args });
        }
        const end = (calls: number, failures: number) => {
          if (fresh) writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish' });
          record(calls, failures);
        };
        const fail = (errorText: string) => {
          writer.write({ type: 'tool-output-error', toolCallId, errorText });
          end(1, 1);
        };

        if (!name || !options.tools[name]) {
          fail('command_tool_unavailable');
          return;
        }
        const parsed = registry[name]!.inputSchema.safeParse(command.invocation.args);
        if (!parsed.success) {
          fail('command_input_invalid');
          return;
        }
        if (command.approval && !command.approval.approved) {
          writer.write({ type: 'tool-output-denied', toolCallId });
          end(0, 0);
          return;
        }
        const tool = createAiSdkTools({
          tools: { [name]: options.tools[name] },
          ...(managedTurn
            ? {
              beforeToolCall: managedTurn.beforeToolCall,
              afterToolCall: managedTurn.afterToolCall,
              onToolError: managedTurn.onToolError,
              resolveApproval: managedTurn.resolveApproval,
              toolTimeoutMs: managedTurn.toolTimeoutMs,
            }
            : {}),
        })[name]!;
        const executionOptions = { toolCallId, messages: [] };
        if (fresh) {
          let needsApproval: boolean;
          try {
            needsApproval = typeof tool.needsApproval === 'function'
              ? Boolean(await (tool.needsApproval as (input: unknown, options: unknown) => unknown)(parsed.data, executionOptions))
              : tool.needsApproval === true;
          } catch (error) {
            fail(failureCode(error));
            return;
          }
          if (needsApproval) {
            writer.write({ type: 'tool-approval-request', approvalId: `glirastes-approval-${nextId()}`, toolCallId });
            end(0, 0);
            return;
          }
        }
        let output: unknown;
        try {
          output = await tool.execute!(parsed.data, executionOptions);
        } catch (error) {
          fail(failureCode(error));
          return;
        }
        writer.write({ type: 'tool-output-available', toolCallId, output });
        end(1, failedResult(output) ? 1 : 0);
      } catch (error) {
        turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
        options.onError?.(error);
        throw error;
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
}
