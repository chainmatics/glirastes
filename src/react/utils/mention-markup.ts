import type { Mention, MentionData, MentionSerializationConfig } from '../types.js';

const CONTEXT_BLOCK_RE = /<!--\s*context:[\s\S]*?-->\s*/gi;
const MENTION_MARKER_RE = /\{\{mention:([^:}]+):([^:}]+):([^}]+)\}\}/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripContextBlocks(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, '').trimStart();
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
}

function buildContextBlock(
  mentions: SerializableMention[],
  label: string,
): string | null {
  if (mentions.length === 0) return null;
  const summary = mentions
    .map((m) => {
      const displayName = m.displayName ?? m.label ?? m.id;
      return `${displayName} (ID: ${m.id})`;
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
      });
    }
  }

  if (options?.includeContextBlock) {
    const contextLabel = options.contextLabel ?? 'Referenced entities';
    const contextBlock = buildContextBlock(serializedMentions, contextLabel);
    if (contextBlock) {
      return `${contextBlock}${nextText}`.trim();
    }
  }

  return nextText;
}
