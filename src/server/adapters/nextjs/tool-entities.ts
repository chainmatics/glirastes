/**
 * The declared identity of a turn's tools (`Tool.outputEntities`,
 * `Tool.inputEntities`), keyed by the name the model calls each tool by. The
 * built-in stream handler uses it for history compaction and `hideIds` and
 * sends it to the browser as a transient `data-tool-entities` part, only
 * when at least one tool declares something: field names and types, never
 * values. Never sent to the Platform.
 */
import {
  sanitizeEntityDeclarations,
  type EntityDeclarationsByTool,
} from '../../../contracts/entity-declaration.js';

/** Type of the transient stream part that carries the declarations. */
export const TOOL_ENTITIES_PART_TYPE = 'data-tool-entities';

/** The `data` of a `data-tool-entities` part. */
export interface ToolEntitiesPart {
  tools: EntityDeclarationsByTool;
}

/**
 * The declarations of AI tools as `toolsToAiTools` builds them (their
 * `_entities`), by tool name; undefined when no tool declares any.
 */
export function entityDeclarationsOfTools(tools: Readonly<Record<string, unknown>> | undefined): EntityDeclarationsByTool | undefined {
  if (!tools) return undefined;
  const raw: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const entities = typeof tool === 'object' && tool !== null ? (tool as { _entities?: unknown })._entities : undefined;
    if (entities !== undefined) raw[name] = entities;
  }
  const declared = sanitizeEntityDeclarations(raw);
  return Object.keys(declared).length > 0 ? declared : undefined;
}
