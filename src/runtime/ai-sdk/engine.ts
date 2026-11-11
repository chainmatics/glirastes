import { jsonSchema, tool, zodSchema } from 'ai';

export interface AiSdkSourceTool {
  description: string;
  parameters: unknown;
  needsApproval?: unknown;
  execute: (input: unknown, options?: unknown) => unknown | Promise<unknown>;
}

export interface AiSdkToolCall {
  toolName: string;
  input: unknown;
}

export interface AiSdkToolSuccess extends AiSdkToolCall {
  result: unknown;
  durationMs: number;
}

export interface AiSdkToolFailure extends AiSdkToolCall {
  error: unknown;
  durationMs: number;
}

export interface AiSdkToolHooks {
  beforeToolCall?: (call: AiSdkToolCall) => void | Promise<void>;
  afterToolCall?: (call: AiSdkToolSuccess) => void | Promise<void>;
  onToolError?: (call: AiSdkToolFailure) => void | Promise<void>;
  resolveApproval?: (call: AiSdkToolCall) => boolean | Promise<boolean>;
  toolTimeoutMs?: number;
}

export interface AiSdkWrappedTool {
  description?: string;
  needsApproval?: unknown;
  execute?: (input: unknown, options?: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

function isJsonSchemaLike(value: unknown): value is {
  jsonSchema: Readonly<Record<string, unknown>>;
  safeParse: (input: unknown) =>
    | { success: true; data: unknown }
    | {
      success: false;
      error: { issues: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey>; message?: string }> };
    };
} {
  return (
    typeof value === 'object'
    && value !== null
    && 'jsonSchema' in value
    && 'safeParse' in value
    && typeof value.safeParse === 'function'
  );
}

/**
 * The AI SDK validates a model-written call before it executes it, but it
 * runs an approved call from the message history without validating its
 * input again, and that history comes from the client. Every execution
 * therefore validates here. A value the SDK's own `validate` just produced is
 * remembered by identity and not parsed a second time, because the parsed
 * value of a schema with a transform does not parse again.
 */
type InputSchema = ReturnType<typeof jsonSchema> | ReturnType<typeof zodSchema>;
type ValidationResult = { success: true; value: unknown } | { success: false; error: Error };

function toAiSdkInputSchema(parameters: unknown): InputSchema {
  if (!isJsonSchemaLike(parameters)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return zodSchema(parameters as any);
  }
  return jsonSchema(
    parameters.jsonSchema as Parameters<typeof jsonSchema>[0],
    {
      validate: (value) => {
        const parsed = parameters.safeParse(value);
        if (parsed.success) return { success: true, value: parsed.data };
        const detail = parsed.error.issues
          .map((issue) => {
            const path = issue.path?.join('.') ?? '';
            return `${path}${path ? ': ' : ''}${issue.message ?? 'invalid value'}`;
          })
          .join('; ');
        return {
          success: false,
          error: new Error(detail || 'Input does not match local JSON schema'),
        };
      },
    },
  );
}

export function createAiSdkTools(
  options: {
    tools: Record<string, AiSdkSourceTool | unknown>;
    now?: () => number;
  } & AiSdkToolHooks,
): Record<string, AiSdkWrappedTool> {
  const wrapped: Record<string, AiSdkWrappedTool> = {};
  const now = options.now ?? (() => performance.now());

  for (const [toolName, rawTool] of Object.entries(options.tools)) {
    const source = rawTool as AiSdkSourceTool;
    const needsApproval = options.resolveApproval
      ? (input: unknown) => options.resolveApproval!({ toolName, input })
      : source.needsApproval;
    const inputSchema = toAiSdkInputSchema(source.parameters);
    const validateInput = inputSchema.validate as ((value: unknown) => ValidationResult | PromiseLike<ValidationResult>) | undefined;
    const sdkValidated = new WeakSet<object>();
    if (validateInput) {
      (inputSchema as { validate: typeof validateInput }).validate = async (value) => {
        const result = await validateInput(value);
        if (result.success && typeof result.value === 'object' && result.value !== null) {
          sdkValidated.add(result.value);
        }
        return result;
      };
    }
    wrapped[toolName] = tool({
      description: source.description,
      inputSchema,
      needsApproval: needsApproval as Parameters<typeof tool>[0]['needsApproval'],
      execute: async (rawInput: unknown, executionOptions: unknown) => {
        await options.beforeToolCall?.({ toolName, input: rawInput });
        const startedAt = now();
        let input = rawInput;
        try {
          if (validateInput && !(typeof rawInput === 'object' && rawInput !== null && sdkValidated.has(rawInput))) {
            const checked = await validateInput(rawInput);
            if (!checked.success) {
              throw new Error(`Invalid input for tool "${toolName}": ${checked.error.message}`);
            }
            input = checked.value;
          }
          const execution = Promise.resolve(source.execute(input, executionOptions));
          const result = options.toolTimeoutMs === undefined
            ? await execution
            : await withTimeout(execution, options.toolTimeoutMs, toolName);
          await options.afterToolCall?.({
            toolName,
            input,
            result,
            durationMs: Math.max(0, now() - startedAt),
          });
          return result;
        } catch (error) {
          await options.onToolError?.({
            toolName,
            input,
            error,
            durationMs: Math.max(0, now() - startedAt),
          });
          throw error;
        }
      },
      // AI SDK's generic tool return type is wider than the stable surface
      // Glirastes exposes here.
    } as unknown as Parameters<typeof tool>[0]) as AiSdkWrappedTool;
  }

  return wrapped;
}

async function withTimeout<T>(
  execution: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('toolTimeoutMs must be a positive finite number');
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
