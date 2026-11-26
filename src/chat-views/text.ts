/**
 * Deterministic text form of a resolved chat view (Markdown): the fallback
 * for surfaces that cannot render components, for stored history and for
 * copy. Neutral module, no rendering framework. Money and dates use `Intl`
 * in the requested locale (dates in UTC so the output does not depend on the
 * machine).
 */
import type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
  ResolvedChatView,
} from '../contracts/chat-view.js';

export interface ChatViewTextOptions {
  /** BCP 47 locale for numbers, dates and fixed phrases; default `en`. */
  locale?: string;
}

/**
 * The fixed phrases of a view, per language; `{count}` is filled in. Shared
 * with the React binding (its locale defaults), so both say the same.
 */
export const CHAT_VIEW_PHRASES = {
  en: {
    said: 'computed by the assistant',
    partial: 'excerpt — not all entries shown',
    more: '+{count} more',
  },
  de: {
    said: 'vom Assistenten berechnet',
    partial: 'Auszug – nicht alle Einträge',
    more: '+{count} weitere',
  },
} as const;

/** The phrase table of a BCP 47 locale (German or English). */
export function chatViewPhrasesOf(locale: string | undefined): (typeof CHAT_VIEW_PHRASES)[keyof typeof CHAT_VIEW_PHRASES] {
  return locale?.toLowerCase().startsWith('de') ? CHAT_VIEW_PHRASES.de : CHAT_VIEW_PHRASES.en;
}

function phrasesOf(locale: string) {
  const table = chatViewPhrasesOf(locale);
  return {
    said: ` (${table.said})`,
    partial: `(${table.partial})`,
    more: (count: number) => `(${table.more.replace('{count}', String(count))})`,
  };
}

type Element = ResolvedChatView['elements'][string];
type Json = Record<string, unknown>;

interface Context {
  view: ResolvedChatView;
  entries: Map<string, ChatComponentManifestEntry>;
  locale: string;
  phrases: ReturnType<typeof phrasesOf>;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function moneyText(props: Json, locale: string): string {
  const { amount, currency } = props;
  if (typeof amount !== 'number' || typeof currency !== 'string') return scalarText(amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function dateTimeText(props: Json, locale: string): string {
  const { value, mode } = props;
  if (typeof value !== 'string') return scalarText(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(
      locale,
      mode === 'datetime'
        ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
        : { dateStyle: 'medium', timeZone: 'UTC' },
    ).format(date);
  } catch {
    return value;
  }
}

/** Single-line text of an element's own props (no children), by id or by its text rule. */
function inlineText(context: Context, type: string, props: Json): string {
  if (type === 'Money') return moneyText(props, context.locale);
  if (type === 'DateTime') return dateTimeText(props, context.locale);
  if (type === 'Action') return '';
  const entry = context.entries.get(type);
  const rule = entry?.text;
  if (!rule) return '';
  const label = rule.label ? scalarText(props[rule.label]) : '';
  const value = rule.value ? scalarText(props[rule.value]) : '';
  if (label && value) return `${label}: ${value}`;
  return value || label;
}

const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function tableText(context: Context, element: Element, entry: ChatComponentManifestEntry): string {
  const columnsProp = entry.text.columns ?? 'columns';
  const columns = (Array.isArray(element.props[columnsProp]) ? element.props[columnsProp] : [])
    .filter(isRecord)
    .map((column) => ({ header: scalarText(column.header), cell: scalarText(column.cell) }));
  const lines: string[] = [];
  if (columns.length > 0) {
    lines.push(`| ${columns.map((column) => cell(column.header)).join(' | ')} |`);
    lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of element.rows ?? []) {
      const texts = columns.map((column) => {
        const cellElement = context.view.elements[column.cell];
        const cellProps = row[column.cell];
        if (!cellElement || !isRecord(cellProps)) return '';
        return cell(inlineText(context, cellElement.type, cellProps));
      });
      lines.push(`| ${texts.join(' | ')} |`);
    }
  }
  const more = element.props.truncatedRows;
  if (typeof more === 'number' && more > 0) lines.push(context.phrases.more(more));
  if (element.props.partial === true) lines.push(context.phrases.partial);
  return lines.join('\n');
}

function keyValueText(element: Element, entry: ChatComponentManifestEntry): string {
  const itemsProp = entry.text.rows ?? 'items';
  const items = Array.isArray(element.props[itemsProp]) ? element.props[itemsProp] : [];
  return items
    .filter(isRecord)
    .map((item) => `${scalarText(item.label)}: ${scalarText(item.value)}`)
    .join('\n');
}

function elementText(context: Context, id: string, seen: Set<string>): string {
  const element = context.view.elements[id];
  if (!element || seen.has(id)) return '';
  seen.add(id);
  const entry = context.entries.get(element.type);
  const blocks: string[] = [];
  if (entry) {
    if (element.type === 'Table') blocks.push(tableText(context, element, entry));
    else if (element.type === 'KeyValue') blocks.push(keyValueText(element, entry));
    else if (element.type === 'Card' && entry.text.label) {
      const title = scalarText(element.props[entry.text.label]);
      if (title) blocks.push(`**${title}**`);
    } else {
      const own = inlineText(context, element.type, element.props);
      blocks.push(element.type === 'Stat' && element.said ? `${own}${context.phrases.said}` : own);
    }
  }
  for (const childId of element.children ?? []) blocks.push(elementText(context, childId, seen));
  seen.delete(id);
  return blocks.filter((block) => block.length > 0).join('\n\n');
}

function contextOf(view: ResolvedChatView, manifest: ChatComponentManifest, options?: ChatViewTextOptions): Context {
  const locale = options?.locale ?? 'en';
  return {
    view,
    entries: new Map(manifest.components.map((entry) => [entry.id, entry])),
    locale,
    phrases: phrasesOf(locale),
  };
}

/** The whole view as Markdown: caption first, then the element tree from the root. */
export function chatViewToText(
  view: ResolvedChatView,
  manifest: ChatComponentManifest,
  options?: ChatViewTextOptions,
): string {
  const context = contextOf(view, manifest, options);
  return [view.caption ?? '', elementText(context, view.root, new Set())]
    .filter((block) => block.length > 0)
    .join('\n\n');
}

/** One element and its subtree as Markdown (no caption); empty for an unknown id. */
export function chatElementToText(
  view: ResolvedChatView,
  elementId: string,
  manifest: ChatComponentManifest,
  options?: ChatViewTextOptions,
): string {
  return elementText(contextOf(view, manifest, options), elementId, new Set());
}
