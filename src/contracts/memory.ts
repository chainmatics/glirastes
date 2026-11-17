/**
 * Wire protocol of the chat memory between the chat handler and the chat UI.
 * Dependency-free so the React bundle and the server adapters share it.
 */

export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember' as const;
export const MEMORY_FORGET_TOOL_NAME = 'memory_forget' as const;

/** Persisted part of an assistant message: the summary of the chat up to `upTo`. */
export const MEMORY_SUMMARY_PART = 'data-memory-summary' as const;
/** Transient part: the user's notes after a change, for a browser-side store. */
export const MEMORY_NOTES_PART = 'data-memory-notes' as const;
/** Request body field that carries the browser-side notes. */
export const MEMORY_BODY_FIELD = 'glirastesMemory' as const;

export const MEMORY_MAX_NOTE_LENGTH = 240;
export const MEMORY_MAX_USER_NOTES = 20;
export const MEMORY_MAX_SHARED_NOTES = 30;
export const MEMORY_MAX_SUMMARY_LENGTH = 2_400;

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  /** Who wrote the note; set by the server, never by the model. */
  readonly authorId?: string;
  /** ISO timestamp. */
  readonly createdAt: string;
}

export interface MemorySummary {
  readonly summary: string;
  /** Id of the last message the summary covers. */
  readonly upTo: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads note entries from untrusted input; malformed and oversized ones drop. */
export function readMemoryEntries(value: unknown, max: number): MemoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: MemoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { id, content, createdAt, authorId } = item;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || seen.has(id)) continue;
    if (typeof content !== 'string' || content.trim().length === 0) continue;
    seen.add(id);
    entries.push({
      id,
      content: content.trim().slice(0, MEMORY_MAX_NOTE_LENGTH),
      createdAt: typeof createdAt === 'string' ? createdAt.slice(0, 40) : new Date(0).toISOString(),
      ...(typeof authorId === 'string' && authorId.length <= 128 ? { authorId } : {}),
    });
  }
  return entries.slice(-max);
}

/** Reads a summary part's data; null when it is not one. */
export function readMemorySummary(value: unknown): MemorySummary | null {
  if (!isRecord(value)) return null;
  const { summary, upTo } = value;
  if (typeof summary !== 'string' || summary.trim().length === 0) return null;
  if (typeof upTo !== 'string' || upTo.length === 0 || upTo.length > 128) return null;
  return { summary: summary.trim().slice(0, MEMORY_MAX_SUMMARY_LENGTH), upTo };
}
