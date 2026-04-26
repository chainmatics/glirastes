import { normalizeResultUiAction } from '../../core/index.js';
import type { ExecuteToolOptions, ExecuteToolResult } from './types.js';

/**
 * Execute a single tool from a Server Action context.
 * The SDK does not perform authorization — permission checks happen in the
 * backend API that each tool calls.
 */
export async function executeTool(
  options: ExecuteToolOptions,
): Promise<ExecuteToolResult> {
  const {
    toolName,
    input,
    tools,
    locale = 'en-US',
    uiActionSchema,
  } = options;

  const tool = tools[toolName];
  if (!tool) {
    return { success: false, error: `Tool "${toolName}" not found.` };
  }

  const context = {
    currentDate: new Date(),
    locale,
  };

  try {
    const rawResult = await tool.execute(input, context);
    const result = uiActionSchema
      ? normalizeResultUiAction(rawResult, uiActionSchema)
      : rawResult;

    const record =
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)
        : { data: result };

    return {
      success: record.success !== false,
      data: record,
      uiAction: record.uiAction as Record<string, unknown> | undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
