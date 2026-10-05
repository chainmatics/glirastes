import { z } from 'zod';
import type {
  ToolDiscoveryResult,
  TurnToolDiscovery,
} from '../../../runtime/index.js';

const FindToolsInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
});

/**
 * SDK-provided tools that are never domain capabilities: registry-mode
 * `find_tools` never indexes them, and they are not manifest tools.
 */
export const NON_DOMAIN_TOOL_NAMES = Object.freeze([
  'find_tools',
  'suggest_followups',
  'ask_clarification',
] as const);

export interface HybridToolDiscovery {
  readonly turnId: string;
  readonly tool: {
    description: string;
    parameters: typeof FindToolsInputSchema;
    execute(input: unknown): Promise<{
      tools: ReadonlyArray<ToolDiscoveryResult>;
    }>;
  };
  activeToolNames(): ReadonlyArray<string>;
  prepareStep(): { activeTools: ReadonlyArray<string> };
}

/**
 * Turn-local activation bookkeeping. Only names emitted by the immutable
 * discovery index can be added; model-supplied names and descriptors are
 * ignored by construction.
 */
export function createHybridToolDiscovery(options: {
  discovery: TurnToolDiscovery;
  initialToolNames: ReadonlyArray<string>;
  /**
   * Server-configured SDK tools (for example `ask_clarification`) that stay
   * active for the whole turn. They are never searchable or model-supplied.
   */
  builtinToolNames?: ReadonlyArray<string>;
}): HybridToolDiscovery {
  const eligible = new Set(options.discovery.eligibleNames);
  const builtins = [...new Set(options.builtinToolNames ?? [])]
    .filter((name) => name !== 'find_tools' && !eligible.has(name));
  const active = new Set(
    options.initialToolNames.filter((name) => eligible.has(name)),
  );
  const activeNames = () => Object.freeze(
    ['find_tools', ...builtins, ...active]
      .sort((left, right) => left.localeCompare(right)),
  );

  const controller: HybridToolDiscovery = {
    turnId: options.discovery.turnId,
    tool: {
      description:
        'Find eligible tools for the current turn by capability or intent.',
      parameters: FindToolsInputSchema,
      async execute(input: unknown) {
        const { query } = FindToolsInputSchema.parse(input);
        const tools = options.discovery.search(query);
        for (const match of tools) {
          if (eligible.has(match.name)) active.add(match.name);
        }
        return { tools };
      },
    },
    activeToolNames: activeNames,
    prepareStep: () => ({ activeTools: activeNames() }),
  };
  return Object.freeze(controller);
}
