import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';

/**
 * Keeps technical ids out of the assistant's answers. Tool results teach the
 * transform which id belongs to which readable label; an id the model writes
 * anyway is replaced by that label, or removed when no label is known.
 */

export const HIDE_IDS_PROMPT =
  'Never write technical ids (UUIDs, database ids, userId, teamId and the like) in your answers, '
  + 'not even in parentheses or lists. Name things by their title, name or readable key instead.';

type Part = TextStreamPart<ToolSet>;
type TextDelta = Extract<Part, { type: 'text-delta' }>;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const LABEL_KEYS = ['title', 'name', 'displayName', 'label'];
const MAX_HELD = 80;

export type IdLabels = Map<string, string | undefined>;

function isIdKey(key: string): boolean {
  return key === 'id' || /(?:Id|_id|Ids|_ids)$/.test(key);
}

/** A non-UUID value counts as an id only when it cannot be an ordinary word. */
function looksLikeId(value: string): boolean {
  if (UUID.test(value)) return true;
  return value.length >= 8 && !/\s/.test(value) && /\d/.test(value) && /^[\w-]+$/.test(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ownLabel(record: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(record)) {
    if (/identifier$/i.test(key) || key === 'key') {
      const value = stringField(record, key);
      if (value) return value;
    }
  }
  for (const key of LABEL_KEYS) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}

function siblingLabel(record: Record<string, unknown>, idKey: string): string | undefined {
  const stem = idKey.replace(/(?:Id|_id)$/, '');
  for (const suffix of ['DisplayName', 'Name', 'Title', 'Label', '_name', '_title']) {
    const value = stringField(record, `${stem}${suffix}`);
    if (value) return value;
  }
  return undefined;
}

function remember(labels: IdLabels, id: string, label: string | undefined): void {
  if (!looksLikeId(id) || label === id) return;
  if (label !== undefined || !labels.has(id)) labels.set(id, label ?? labels.get(id));
}

/** Records the ids in a tool input or output, with the label each one has. */
export function collectIdLabels(value: unknown, labels: IdLabels, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectIdLabels(item, labels, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (isIdKey(key)) {
      const label = key === 'id' ? ownLabel(record) : siblingLabel(record, key);
      if (typeof item === 'string') remember(labels, item, label);
      else if (Array.isArray(item)) for (const entry of item) if (typeof entry === 'string') remember(labels, entry, undefined);
    }
    if (item && typeof item === 'object') collectIdLabels(item, labels, depth + 1);
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function idPattern(labels: IdLabels): string {
  const known = [...labels.keys()].filter((id) => !UUID.test(id)).sort((a, b) => b.length - a.length).map(escape);
  return known.length > 0 ? `(?:${UUID_SOURCE}|${known.join('|')})` : UUID_SOURCE;
}

/** Replaces the ids in a finished piece of text. */
export function redactIds(text: string, labels: IdLabels): string {
  if (!text) return text;
  const id = idPattern(labels);
  const prefix = String.raw`(?:(?:uu)?ids?|kennung)\s*[:=]?\s*`;
  const wrapped = new RegExp(String.raw`[ \t]*[(\[]\s*(?:${prefix})?\x60?${id}\x60?\s*[)\]]`, 'gi');
  const prefixed = new RegExp(String.raw`[ \t]*[,;–-]?[ \t]*\b${prefix}\x60?${id}\x60?`, 'gi');
  const bare = new RegExp(String.raw`(?<![\w-])\x60?(${id})\x60?(?![\w-])`, 'gi');
  return text
    .replace(wrapped, '')
    .replace(prefixed, '')
    .replace(bare, (_match, found: string) => labelFor(labels, found) ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?)])/g, '$1');
}

function labelFor(labels: IdLabels, id: string): string | undefined {
  if (labels.has(id)) return labels.get(id);
  for (const [known, label] of labels) if (known.toLowerCase() === id.toLowerCase()) return label;
  return undefined;
}

/** Where the text may still grow into an id or its wrapper; the rest is safe to emit. */
export function holdFrom(text: string): number {
  const match = /[ \t]*(?:[,;–-][ \t]*)?(?:[(\[]\s*)?(?:\b(?:u|uu|uui|uuid|i|id|ids|k|ke|ken|kenn|kennu|kennun|kennung)\s*[:=]?\s*)?\x60?[\w-]*$/i.exec(text);
  const index = match ? match.index : text.length;
  return Math.max(index, text.length - MAX_HELD);
}

/**
 * `experimental_transform` for `streamText`: holds back the end of each text
 * part until it can no longer grow into an id, and emits it with ids replaced.
 */
export function createHideIdsTransform(labels: IdLabels = new Map()): StreamTextTransform<ToolSet> {
  return () => {
    const held = new Map<string, { part: TextDelta; text: string }>();
    const flush = (controller: TransformStreamDefaultController<Part>, id?: string) => {
      for (const [key, entry] of held) {
        if (id !== undefined && key !== id) continue;
        const text = redactIds(entry.text, labels);
        if (text) controller.enqueue({ ...entry.part, text });
        held.delete(key);
      }
    };
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        if (part.type === 'text-delta') {
          const key = part.id;
          const text = (held.get(key)?.text ?? '') + part.text;
          const cut = holdFrom(text);
          const ready = redactIds(text.slice(0, cut), labels);
          if (ready) controller.enqueue({ ...part, text: ready });
          held.set(key, { part, text: text.slice(cut) });
          return;
        }
        if (part.type === 'tool-call') collectIdLabels(part.input, labels);
        if (part.type === 'tool-result') {
          collectIdLabels(part.input, labels);
          collectIdLabels(part.output, labels);
        }
        flush(controller, part.type === 'text-end' ? part.id : undefined);
        controller.enqueue(part);
      },
      flush(controller) {
        flush(controller);
      },
    });
  };
}
