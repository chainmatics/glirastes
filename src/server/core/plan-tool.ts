import { z } from 'zod';
import { defineTool, type Tool } from '../../types.js';
import {
  PLAN_ITEM_STATUSES,
  PLAN_MAX_ITEMS,
  PLAN_MAX_TITLE_LENGTH,
  PLAN_TOOL_NAME,
} from '../../contracts/plan.js';

export interface PlanningConfig {
  /** Default true when the object is provided. */
  enabled?: boolean;
  /** Replaces the model-facing description, e.g. for a German-only prompt. */
  description?: string;
}

const DEFAULT_DESCRIPTION = [
  'Show the user a short task list when a request needs several distinct',
  'actions (for example: find tasks, then create a team, then invite members).',
  'Never call it for a simple request that one or two tool calls answer.',
  'Call it once before you start, then again with updated statuses whenever an',
  'item starts or finishes. Keep exactly one item in_progress while you work.',
].join(' ');

export const PlanInputSchema = z.object({
  items: z.array(z.object({
    title: z.string().trim().min(1).max(PLAN_MAX_TITLE_LENGTH),
    status: z.enum(PLAN_ITEM_STATUSES),
  })).min(2).max(PLAN_MAX_ITEMS),
});

/**
 * Built-in, side-effect-free planning tool. It never calls the app; the chat
 * UI renders the latest call as a checklist and the turn simply continues.
 */
export function createPlanTool(config?: PlanningConfig): Tool | null {
  if (config?.enabled === false) return null;
  return defineTool({
    id: PLAN_TOOL_NAME,
    description: config?.description ?? DEFAULT_DESCRIPTION,
    inputSchema: PlanInputSchema,
    needsApproval: false,
    execute: async (input) => ({ success: true, items: input.items.length }),
  });
}
