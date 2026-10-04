import type {
  Mention,
  MentionData,
  MentionResult,
  MentionSerializationConfig,
} from '../types.js';

const CONTEXT_BLOCK_RE = /<!--\s*context:[\s\S]*?-->\s*/gi;
const MENTION_MARKER_RE = /\{\{mention:([^:}]+):([^:}]+):([^}]+)\}\}/g;
const DEFINITION_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const MAX_TOOL_ARGS_LENGTH = 2_000;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripContextBlocks(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, '').trimStart();
}

/**
 * The text that tells the model which catalog definition a tool-backed
 * command runs and with which arguments (`tool: ui.navigate, args: {...}`),
 * or `undefined` when the definition id or the arguments cannot be sent
 * safely. Arguments must be a JSON object of at most 2000 characters; `<` and
 * `>` stay escaped so they can never close the surrounding context comment.
 */
export function describeToolReference(
  definitionId: unknown,
  args?: unknown,
): string | undefined {
  if (typeof definitionId !== 'string' || !DEFINITION_ID_RE.test(definitionId)) return undefined;
  if (args === undefined) return `tool: ${definitionId}`;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length > MAX_TOOL_ARGS_LENGTH) return undefined;
  const safe = json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `tool: ${definitionId}, args: ${safe}`;
}

/**
 * The structured mention a picked completion result becomes in the composer.
 * A tool-backed command keeps its `definitionId` and `args`, because the
 * serializer needs them to tell the model what the command runs.
 */
export function mentionDataFromResult(
  result: MentionResult,
  token: { prefix: string; slug: string },
): MentionData {
  return {
    id: result.id,
    type: result.type,
    label: result.label,
    displayName: result.label,
    slug: token.slug,
    prefix: token.prefix,
    ...(result.definitionId ? { definitionId: result.definitionId } : {}),
    ...(result.args ? { args: result.args } : {}),
  };
}

export function inferMentionPrefix(type: string): string {
  return type === 'task' || type === 'command' ? '/' : '@';
}

export function normalizeMentionSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export type MentionTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; mention: Mention };

export function parseMentionSegments(text: string): MentionTextSegment[] {
  const segments: MentionTextSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  MENTION_MARKER_RE.lastIndex = 0;

  while ((match = MENTION_MARKER_RE.exec(text)) !== null) {
    const [raw, type, id, label] = match;
    const start = match.index;
    const end = start + raw.length;

    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) });
    }

    segments.push({
      kind: 'mention',
      mention: {
        id,
        type,
        displayName: label,
        prefix: inferMentionPrefix(type),
      },
    });

    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }

  return segments;
}

interface SerializableMention {
  id: string;
  type: string;
  label?: string;
  displayName?: string;
  slug?: string;
  prefix?: string;
  /** From `describeToolReference`; only tool-backed commands have one. */
  toolReference?: string;
}

function buildContextBlock(
  mentions: SerializableMention[],
  label: string,
): string | null {
  if (mentions.length === 0) return null;
  const summary = mentions
    .map((m) => {
      const displayName = m.displayName ?? m.label ?? m.id;
      return `${displayName} (ID: ${m.id}${m.toolReference ? `, ${m.toolReference}` : ''})`;
    })
    .join(', ');
  return `<!--context:[${label}: ${summary}]--> `;
}

export function serializeMentionsForSend(
  text: string,
  mentions: MentionData[],
  options?: MentionSerializationConfig,
): string {
  const enabled = options?.enabled ?? true;
  if (!enabled || mentions.length === 0) {
    return stripContextBlocks(text);
  }

  const cleaned = stripContextBlocks(text);
  let nextText = cleaned;
  const serializedMentions: SerializableMention[] = [];

  // One command can arrive twice: as a chip read back from the editor DOM
  // (dataset only, so without definition id and arguments) and as the state
  // entry that still carries them. Only the entry first in line replaces the
  // token, so the reference is looked up per mention, not per entry.
  const toolReferences = new Map<string, string>();
  for (const mention of mentions) {
    if (typeof mention.id !== 'string' || typeof mention.type !== 'string') continue;
    if (mention.definitionId === undefined) continue;
    const key = `${mention.type}\u0000${mention.id}`;
    if (toolReferences.has(key)) continue;
    const reference = describeToolReference(mention.definitionId, mention.args);
    if (reference) toolReferences.set(key, reference);
  }

  for (const mention of mentions) {
    const id = typeof mention.id === 'string' ? mention.id : '';
    const type = typeof mention.type === 'string' ? mention.type : '';
    if (!id || !type) continue;

    const label = typeof mention.label === 'string'
      ? mention.label
      : typeof mention.displayName === 'string'
      ? mention.displayName
      : id;

    const slug = typeof mention.slug === 'string' && mention.slug.trim().length > 0
      ? mention.slug.trim()
      : normalizeMentionSlug(label);

    const prefix = typeof mention.prefix === 'string' && mention.prefix.length > 0
      ? mention.prefix
      : inferMentionPrefix(type);

    const token = `${prefix}${slug}`;
    const marker = `{{mention:${type}:${id}:${label}}}`;
    const tokenPattern = new RegExp(`(^|\\s)${escapeRegex(token)}(?=\\s|$)`, 'g');
    let wasInserted = false;

    nextText = nextText.replace(tokenPattern, (fullMatch, leading: string) => {
      wasInserted = true;
      return `${leading}${marker}`;
    });

    if (wasInserted) {
      serializedMentions.push({
        id,
        type,
        label,
        displayName: label,
        slug,
        prefix,
        toolReference: toolReferences.get(`${type}\u0000${id}`),
      });
    }
  }

  // A tool-backed command is only meaningful with its definition and
  // arguments, so those always reach the model; other mentions need the option.
  const contextMentions = options?.includeContextBlock
    ? serializedMentions
    : serializedMentions.filter((m) => m.toolReference);
  const contextBlock = buildContextBlock(
    contextMentions,
    options?.contextLabel ?? 'Referenced entities',
  );
  if (contextBlock) {
    return `${contextBlock}${nextText}`.trim();
  }

  return nextText;
}
