/**
 * Wire protocol between the built-in `update_plan` tool and the chat UI.
 * Dependency-free so both the React bundle and the server adapters can
 * import it without pulling in Zod.
 */

export const PLAN_TOOL_NAME = 'update_plan' as const;

export const PLAN_ITEM_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

/** Shared by the server tool schema and the chat UI reader. */
export const PLAN_MAX_ITEMS = 12;
export const PLAN_MAX_TITLE_LENGTH = 120;

export interface PlanItem {
  readonly title: string;
  readonly status: PlanItemStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the items of an `update_plan` input, dropping malformed entries.
 * Returns null when the input carries no item list at all.
 */
export function readPlanItems(input: unknown): PlanItem[] | null {
  if (!isRecord(input) || !Array.isArray(input.items)) return null;
  const items: PlanItem[] = [];
  for (const entry of input.items) {
    if (!isRecord(entry) || typeof entry.title !== 'string') continue;
    const title = entry.title.trim().slice(0, PLAN_MAX_TITLE_LENGTH);
    const status = entry.status;
    if (!title || !PLAN_ITEM_STATUSES.includes(status as PlanItemStatus)) continue;
    items.push({ title, status: status as PlanItemStatus });
    if (items.length === PLAN_MAX_ITEMS) break;
  }
  return items;
}
