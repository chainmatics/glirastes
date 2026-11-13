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
  'update_plan',
] as const);

export interface HybridToolDiscovery {
  readonly turnId: string;
  readonly tool: {
    description: string;
    parameters: typeof FindToolsInputSchema;
    execute(input: unknown): Promise<{
      tools: ReadonlyArray<ToolDiscoveryResult>;
      /** Set when the search added no new tool. */
      note?: string;
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
        'Load more tools for this turn. Call it only when none of the tools you already have fits the request; '
        + 'call a fitting tool directly instead. Describe the missing capability in a few words '
        + '(for example "delete a task attachment"). Found tools can be called in the next step.',
      parameters: FindToolsInputSchema,
      async execute(input: unknown) {
        const { query } = FindToolsInputSchema.parse(input);
        const tools = options.discovery.search(query);
        const before = active.size;
        for (const match of tools) {
          if (eligible.has(match.name)) active.add(match.name);
        }
        if (tools.length === 0) {
          return { tools, note: 'No tool fits this search. Use the tools you have, or ask the user.' };
        }
        if (active.size === before) {
          return { tools, note: 'These tools were already available. Call one of them directly instead of searching again.' };
        }
        return { tools };
      },
    },
    activeToolNames: activeNames,
    prepareStep: () => ({ activeTools: activeNames() }),
  };
  return Object.freeze(controller);
}
