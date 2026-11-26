/**
 * Element ids inside a spec: the prop form (`chatElementId()`), the marker it
 * leaves in the manifest's JSON Schema, and where an item-scope component
 * names its cell elements. Neutral module.
 */
import { z } from 'zod';
import type { ChatComponentManifestEntry } from '../contracts/chat-view.js';

/** Marker the catalog puts on string props that name another element (JSON Schema `description`). */
export const ELEMENT_ID_MARKER = '#id';

/**
 * A prop naming another element of the same spec, e.g. the cell element of a
 * table column. An item-scope component (`itemScope.cellsProp`) needs one
 * such field in the entries of its cells prop.
 */
export function chatElementId(): z.ZodString {
  return z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe(ELEMENT_ID_MARKER);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names of the element-id fields of the items of an item-scope cells prop. */
export function cellIdFields(entry: Pick<ChatComponentManifestEntry, 'props' | 'itemScope'>): string[] {
  const scope = entry.itemScope;
  const props = isRecord(entry.props.properties) ? entry.props.properties : {};
  const cells = scope ? props[scope.cellsProp] : undefined;
  const items = isRecord(cells) && isRecord(cells.items) ? cells.items : undefined;
  const fields = items && isRecord(items.properties) ? items.properties : {};
  return Object.entries(fields)
    .filter(([, schema]) => isRecord(schema) && schema.description === ELEMENT_ID_MARKER)
    .map(([name]) => name);
}
