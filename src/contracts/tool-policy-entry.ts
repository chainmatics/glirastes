import { z } from 'zod';

/**
 * Leaf module of the policy contract. `revisions.ts` (signed Platform
 * revisions) and `tool-policy.ts` (local policy resolution) both import it
 * and it imports neither, so the two never form an ESM import cycle.
 */
export const ToolRiskClassSchema = z.enum([
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
  'unknown',
]);

export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const ToolPolicyPinSchema = z.object({
  toolId: z.uuid(),
  atRiskClass: ToolRiskClassSchema,
}).strict();

/** One policy layer entry: the same shape for local files and Platform deltas. */
export const ToolPolicyEntrySchema = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  riskClass: ToolRiskClassSchema.optional(),
  allowedRoles: z.array(boundedText(200)).max(100).optional(),
  description: boundedText(4_000).optional(),
  reason: boundedText(500).optional(),
  pin: ToolPolicyPinSchema.optional(),
}).strict();

export interface ToolPolicyEntry {
  enabled?: boolean;
  requiresApproval?: boolean;
  riskClass?: ToolRiskClass;
  allowedRoles?: string[];
  description?: string;
  reason?: string;
  pin?: { toolId: string; atRiskClass: ToolRiskClass };
}

/**
 * A signed Platform decision for one tool the deployed code reported
 * (P08b shared contract item 1): only fields an operator decided, never a
 * copy of the local value. The runtime applies its restrictions, and its
 * `requiresApproval: false` only as the pinned D16 relaxation up to tier 2.
 */
export const ToolOverrideDeltaSchema = ToolPolicyEntrySchema.extend({
  toolId: z.uuid(),
}).strict();

export type ToolOverrideDelta = { toolId: string } & ToolPolicyEntry;
