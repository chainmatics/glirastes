import type {
  Mention,
  MentionData,
  MentionResult,
  MentionSerializationConfig,
} from '../types.js';
import { escapeCommentDelimiters, escapeJsonAngles } from '../../contracts/delimited-text.js';
import {
  canonicalMentionLabel,
  firstCodePoints,
  MAX_INPUT_CODE_POINTS,
  parseMentionMarkers,
  serializeMentionMarker,
} from '../../contracts/mention-marker.js';

const CONTEXT_OPEN_RE = /<!--\s*context:/iy;
const DEFINITION_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const MAX_TOOL_ARGS_LENGTH = 2_000;

/**
 * Removes `<!-- context: … -->` blocks and the whitespace after them. Scans with
 * indexOf instead of one lazy regex, which is quadratic on many unclosed openers.
 */
/**
 * Steps of the last `serializeMentionsForSend` call, for the linearity
 * test: every loop it runs adds one per iteration (context blocks
 * stripped, token candidates, text positions checked or claimed, sort
 * comparisons, claims written and listed, context entries). Internal.
 */
export const serializeWork = { steps: 0 };

export function stripContextBlocks(text: string): string {
  let kept = '';
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open < 0) break;
    serializeWork.steps += 1;
    CONTEXT_OPEN_RE.lastIndex = open;
    if (!CONTEXT_OPEN_RE.test(text)) {
      from = open + 4;
      continue;
    }
    const close = text.indexOf('-->', CONTEXT_OPEN_RE.lastIndex);
    if (close < 0) break;
    kept += text.slice(cursor, open);
    let end = close + 3;
    while (end < text.length && /\s/.test(text[end]!)) {
      end += 1;
      serializeWork.steps += 1;
    }
    cursor = end;
    from = end;
  }
  return (kept + text.slice(cursor)).trimStart();
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
  return `tool: ${definitionId}, args: ${escapeJsonAngles(json)}`;
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

/**
 * A mention's tool reference as chip `dataset` values, so a chip read back
 * from the editor keeps the definition id and arguments of the command it
 * stands for. `undefined` when the mention has none, or none the model could
 * be given.
 */
export function toolReferenceToDataset(
  mention: MentionData,
): { definitionId: string; args?: string } | undefined {
  if (mention.definitionId === undefined) return undefined;
  if (describeToolReference(mention.definitionId, mention.args) === undefined) return undefined;
  const definitionId = mention.definitionId as string;
  return mention.args === undefined
    ? { definitionId }
    : { definitionId, args: JSON.stringify(mention.args) };
}

/**
 * The inverse of `toolReferenceToDataset`: the `definitionId` (and `args`)
 * stored in a chip's dataset, or `undefined` when there is none or it is
 * malformed. It is validated like a reference taken from a picked result.
 */
export function toolReferenceFromDataset(dataset: {
  mentionDefinitionId?: string;
  mentionArgs?: string;
}): { definitionId: string; args?: Record<string, unknown> } | undefined {
  const definitionId = dataset.mentionDefinitionId;
  if (!definitionId) return undefined;
  let args: Record<string, unknown> | undefined;
  if (dataset.mentionArgs !== undefined) {
    try {
      args = JSON.parse(dataset.mentionArgs) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (describeToolReference(definitionId, args) === undefined) return undefined;
  return args === undefined ? { definitionId } : { definitionId, args };
}

export function inferMentionPrefix(type: string): string {
  return type === 'command' ? '/' : '@';
}

export function normalizeMentionSlug(value: string): string {
  // Capped before NFKD, which is quadratic on long runs of combining marks.
  return firstCodePoints(value, MAX_INPUT_CODE_POINTS)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export type MentionTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; mention: Mention };

/**
 * Splits text at its mention markers. `prefixOf` gives a mention's visible
 * prefix by type (default `inferMentionPrefix`); the chat context's
 * `mentionPrefix` applies the provider's `triggers`.
 */
export function parseMentionSegments(
  text: string,
  prefixOf: (type: string) => string = inferMentionPrefix,
): MentionTextSegment[] {
  const segments: MentionTextSegment[] = [];
  let cursor = 0;

  // Read as written: a legacy marker keeps its label here (the read path is not canonical yet).
  for (const { type, id, label, span: { start, end } } of parseMentionMarkers(text)) {
    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) });
    }

    segments.push({
      kind: 'mention',
      mention: {
        id,
        type,
        displayName: label,
        prefix: prefixOf(type),
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
      serializeWork.steps += 1;
      // A label or id cannot close this block early or nest a comment in it. Not covered (format
      // change needed): the raw label in the marker, and sibling entries forged in this free text.
      const displayName = escapeCommentDelimiters(m.displayName ?? m.label ?? m.id);
      return `${displayName} (ID: ${escapeCommentDelimiters(m.id)}${m.toolReference ? `, ${m.toolReference}` : ''})`;
    })
    .join(', ');
  return `<!--context:[${label}: ${summary}]--> `;
}

const refusedTypes = new Set<string>();
const MAX_REFUSED_TYPES = 100;

/** Development only, as `useAiMissingHandlerWarning`: bundlers replace `process.env.NODE_ENV`. */
function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV === 'development';
  } catch {
    // No `process` global and no bundler replacement (a plain browser module).
    return false;
  }
}

// Static text only: the type, id and label are content or app data (see the sensitive-diagnostics test).
function warnRefusedMention(type: string): void {
  if (!isDevelopment()) return;
  if (refusedTypes.has(type) || refusedTypes.size >= MAX_REFUSED_TYPES) return;
  refusedTypes.add(type);
  console.warn('[glirastes] A mention was sent without a {{mention:…}} marker: its type or id has characters that can hide text (control, format or invisible characters, }, {{, <!, -->). The model gets the typed text, not the id.');
}


/**
 * The occurrences base's `(^|\s)token(?=\s|$)` replacement of this token
 * found, left to right: a candidate must not overlap a position an earlier
 * mention claimed (`claimed`); a boundary character counts only if it is
 * not claimed and, before the token, lies at or after the end of this
 * token's previous match (base consumed it), and the next one starts after it. Claims the
 * accepted occurrences. Steps: one per candidate and per position checked
 * or claimed, so linear in the text for one token.
 */
function claimOccurrences(text: string, token: string, claimed: Uint8Array): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let from = 0;
  /** End of this token's previous match: base's regex consumed the whitespace before a match. */
  let previousEnd = 0;
  // In base's text a claimed position is marker text, never whitespace.
  const isBoundary = (index: number) => !claimed[index] && /\s/.test(text[index]!);
  for (;;) {
    const start = text.indexOf(token, from);
    if (start < 0) return found;
    serializeWork.steps += 1;
    const end = start + token.length;
    const before = start === 0 || (start - 1 >= previousEnd && isBoundary(start - 1));
    const after = end === text.length || isBoundary(end);
    if (!before || !after) {
      from = start + 1;
      continue;
    }
    let free = true;
    for (let i = start; i < end; i += 1) {
      serializeWork.steps += 1;
      if (claimed[i]) { free = false; break; }
    }
    if (!free) {
      from = start + 1;
      continue;
    }
    claimed.fill(1, start, end);
    serializeWork.steps += end - start;
    found.push({ start, end });
    from = end;
    previousEnd = end;
  }
}

/**
 * The text a send gives the model: each mention's token (`prefix` + `slug`,
 * whitespace around it) becomes its `{{mention:type:id:label}}` marker,
 * and tool-backed commands (every mention with `includeContextBlock`) are
 * listed in a leading context block. One pass over the original text: a
 * token occurrence is replaced once, and what is written is never scanned
 * again. A token belongs to the first mention in the list with that token
 * (as before); a mention whose type or id carries characters that can hide
 * text keeps its token as typed, without a marker.
 */
export function serializeMentionsForSend(
  text: string,
  mentions: MentionData[],
  options?: MentionSerializationConfig,
): string {
  serializeWork.steps = 0;
  const enabled = options?.enabled ?? true;
  if (!enabled || mentions.length === 0) {
    return stripContextBlocks(text);
  }

  const cleaned = stripContextBlocks(text);
  const labels = options?.labels === 'raw' ? 'raw' : 'canonical';
  // Mentions are cut value-safe unless the app asks for the 0.24.2 cut.
  const labelCut = options?.labelCut === 'grapheme' ? 'grapheme' : 'value-safe';
  const markerOptions = { labels, maxLabelLength: options?.maxLabelLength, labelCut } as const;

  // One command can arrive twice: as a chip read back from the editor DOM
  // (dataset only, so without definition id and arguments) and as the state
  // entry that still carries them. Only the entry first in line replaces the
  // token, so the reference is looked up per mention, not per entry.
  const toolReferences = new Map<string, string>();
  for (const mention of mentions) {
    serializeWork.steps += 1;
    if (typeof mention.id !== 'string' || typeof mention.type !== 'string') continue;
    if (mention.definitionId === undefined) continue;
    const key = `${mention.type}\u0000${mention.id}`;
    if (toolReferences.has(key)) continue;
    const reference = describeToolReference(mention.definitionId, mention.args);
    if (reference) toolReferences.set(key, reference);
  }

  interface Claim { mention: SerializableMention; marker: string | undefined; start: number; end: number; order: number }
  const claimedTokens = new Set<string>();
  const taken: Claim[] = [];
  const claimed = new Uint8Array(cleaned.length);

  mentions.forEach((mention, order) => {
    serializeWork.steps += 1;
    const id = typeof mention.id === 'string' ? mention.id : '';
    const type = typeof mention.type === 'string' ? mention.type : '';
    if (!id || !type) return;

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
    // The first mention in the list with this token takes every occurrence, as before.
    if (claimedTokens.has(token)) return;
    claimedTokens.add(token);
    // Canonical once: the marker's own canonicalisation of a canonical label is cheap (idempotent).
    const sentLabel = labels === 'raw' ? label : canonicalMentionLabel(label, { id, maxLength: options?.maxLabelLength, cut: labelCut });
    const marker = serializeMentionMarker({ type, id, label: sentLabel }, markerOptions);
    if (marker === undefined) warnRefusedMention(type);
    const serializable: SerializableMention = {
      id,
      type,
      label: sentLabel,
      displayName: sentLabel,
      slug,
      prefix,
      toolReference: toolReferences.get(`${type}\u0000${id}`),
    };
    // An earlier mention's occurrence wins, as when it replaced its token first.
    for (const { start, end } of claimOccurrences(cleaned, token, claimed)) {
      serializeWork.steps += 1;
      taken.push({ mention: serializable, marker, start, end, order });
    }
  });

  taken.sort((a, b) => {
    serializeWork.steps += 1;
    return a.start - b.start;
  });
  let nextText = '';
  let cursor = 0;
  const listed = new Set<number>();
  const serializedMentions: SerializableMention[] = [];
  for (const claim of taken) {
    serializeWork.steps += 1;
    // A refused mention keeps the token the user saw: no label or id of it enters the text.
    nextText += cleaned.slice(cursor, claim.start) + (claim.marker ?? cleaned.slice(claim.start, claim.end));
    cursor = claim.end;
  }
  nextText += cleaned.slice(cursor);
  const byOrder = [...taken].sort((a, b) => {
    serializeWork.steps += 1;
    return a.order - b.order;
  });
  for (const claim of byOrder) {
    serializeWork.steps += 1;
    if (claim.marker === undefined || listed.has(claim.order)) continue;
    listed.add(claim.order);
    serializedMentions.push(claim.mention);
  }

  // A tool-backed command is only meaningful with its definition and
  // arguments, so those always reach the model; other mentions need the option.
  const contextMentions = options?.includeContextBlock
    ? serializedMentions
    : serializedMentions.filter((m) => {
      serializeWork.steps += 1;
      return m.toolReference;
    });
  const contextBlock = buildContextBlock(
    contextMentions,
    options?.contextLabel ?? 'Referenced entities',
  );
  if (contextBlock) {
    return `${contextBlock}${nextText}`.trim();
  }

  return nextText;
}
