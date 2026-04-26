import type { MockToolExecutor } from './types.js';

interface ZodSchema {
  safeParse: (input: unknown) => {
    success: boolean;
    error?: { issues: Array<{ message: string; path: Array<string | number> }> };
  };
}

interface ToolWithSchema {
  inputSchema?: ZodSchema;
  [key: string]: unknown;
}

/**
 * Creates a mock tool executor that validates inputs against Zod schemas
 * and returns the provided mock responses.
 *
 * Does not make any HTTP calls — purely validates and returns mocks.
 */
export function createMockToolExecutor(
  toolRegistry: Record<string, unknown>,
): MockToolExecutor {
  return {
    execute(
      toolName: string,
      input: Record<string, unknown>,
      mockResponse: unknown,
    ) {
      const tool = toolRegistry[toolName] as ToolWithSchema | undefined;

      if (!tool) {
        return {
          success: false,
          validationError: `Tool "${toolName}" not found in registry`,
          response: null,
        };
      }

      if (tool.inputSchema) {
        const result = tool.inputSchema.safeParse(input);
        if (!result.success) {
          const issues = result.error?.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          return {
            success: false,
            validationError: issues ?? 'Validation failed',
            response: null,
          };
        }
      }

      return {
        success: true,
        response: mockResponse,
      };
    },
  };
}
