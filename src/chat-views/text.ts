/**
 * Deterministic text form of a resolved chat view (Markdown): the fallback
 * for surfaces that cannot render components, for stored history and for
 * copy. Neutral module, no rendering framework. Money and dates use `Intl`
 * in the requested locale (dates in UTC so the output does not depend on the
 * machine).
 *
 * Every value in a view is data (tool results, model literals), never markup:
 * in Markdown form each value is escaped so it cannot become a link, image,
 * HTML, emphasis, heading, list or table break; only the structure this module
 * writes itself (tables, the card title's bold, the fixed phrases) is Markdown.
 */
import type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
  ResolvedChatView,
} from '../contracts/chat-view.js';
import { cellIdFields } from './element-id.js';

export interface ChatViewTextOptions {
  /** BCP 47 locale for numbers, dates and fixed phrases; default `en`. */
  locale?: string;
  /**
   * `markdown` (default): Markdown with every value escaped. `plain`: the same
   * text without any escaping or emphasis, for a surface that shows it as plain
   * text (never feed `plain` output to a Markdown renderer).
   */
  format?: 'markdown' | 'plain';
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
  /** Escapes one data value for the output format (identity in plain form). */
  value: (text: string) => string;
  markdown: boolean;
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

/**
 * One data value as inert Markdown text: backslash-escapes every character
 * that can open inline markup (links, images, HTML, entities, emphasis, code,
 * strikethrough, table pipes), escapes a leading block marker (heading,
 * quote, list, setext rule) and folds line breaks into spaces so a value stays
 * on its line and table row. A bare URL or e-mail address stays text, which a
 * GFM renderer may still autolink to exactly that visible address (GFM finds
 * those after unescaping, so no escape can prevent it).
 */
function escapeChatViewMarkdown(text: string): string {
  return text
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\\`*_[\]<>!|~&]/g, '\\$&')
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
}

const collapseLines = (text: string) => text.replace(/\r\n?|\n/g, ' ');

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
  if (type === 'Money') return context.value(moneyText(props, context.locale));
  if (type === 'DateTime') return context.value(dateTimeText(props, context.locale));
  if (type === 'Action') return '';
  const entry = context.entries.get(type);
  const rule = entry?.text;
  if (!rule) return '';
  const label = rule.label ? context.value(scalarText(props[rule.label])) : '';
  const value = rule.value ? context.value(scalarText(props[rule.value])) : '';
  if (label && value) return `${label}: ${value}`;
  return value || label;
}

/** A table cell: values are already escaped (Markdown) or raw (plain); only line breaks fold. */
const cell = collapseLines;

/** The header of a table column: its `header`, else its first other text field. */
function columnHeader(column: Json, idField: string): string {
  if (typeof column.header === 'string') return column.header;
  const other = Object.entries(column).find(([key, value]) => key !== idField && typeof value === 'string');
  return other ? (other[1] as string) : '';
}

/** An item-scope (table-like) component: a column per cells-prop entry, a line per resolved row. */
function tableText(context: Context, element: Element, entry: ChatComponentManifestEntry): string {
  const columnsProp = entry.text.columns ?? entry.itemScope?.cellsProp ?? 'columns';
  const idField = cellIdFields(entry)[0] ?? 'cell';
  const columns = (Array.isArray(element.props[columnsProp]) ? element.props[columnsProp] : [])
    .filter(isRecord)
    .map((column) => ({ header: columnHeader(column, idField), cell: scalarText(column[idField]) }));
  const lines: string[] = [];
  if (columns.length > 0) {
    lines.push(`| ${columns.map((column) => cell(context.value(column.header))).join(' | ')} |`);
    lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of element.rows ?? []) {
      const texts = columns.map((column) => {
        const cellElement = Object.prototype.hasOwnProperty.call(context.view.elements, column.cell)
          ? context.view.elements[column.cell]
          : undefined;
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

/** A list prop (`text.rows` without an item scope): `label: value` per entry, else its scalar values. */
function listText(context: Context, element: Element, rowsProp: string): string {
  const items = Array.isArray(element.props[rowsProp]) ? element.props[rowsProp] : [];
  return items
    .filter(isRecord)
    .map((item) => {
      if (hasOwn(item, 'label') && hasOwn(item, 'value')) {
        return `${context.value(scalarText(item.label))}: ${context.value(scalarText(item.value))}`;
      }
      return Object.values(item)
        .filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
        .map((value) => context.value(scalarText(value)))
        .join(' · ');
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

const hasOwn = (value: Json, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * An element's own text, by its manifest entry's rule: an item scope is a
 * table, `rows` alone a list, a container with only a `label` a title, else
 * the inline `label: value`.
 */
function ownText(context: Context, element: Element, entry: ChatComponentManifestEntry): string {
  const rule = entry.text;
  if (entry.itemScope) return tableText(context, element, entry);
  if (rule.rows) return listText(context, element, rule.rows);
  if (entry.children !== 'none' && rule.label && !rule.value) {
    const title = context.value(scalarText(element.props[rule.label]));
    return title && context.markdown ? `**${title}**` : title;
  }
  const own = inlineText(context, element.type, element.props);
  return own && element.said ? `${own}${context.phrases.said}` : own;
}

/**
 * An element and its subtree. An element whose type the manifest does not
 * know (a catalog that evolved, a client without the app's components) is
 * the text of its children, else nothing.
 */
function elementText(context: Context, id: string, seen: Set<string>): string {
  const element = Object.prototype.hasOwnProperty.call(context.view.elements, id) ? context.view.elements[id] : undefined;
  if (!element || seen.has(id)) return '';
  seen.add(id);
  const entry = context.entries.get(element.type);
  const blocks: string[] = entry ? [ownText(context, element, entry)] : [];
  for (const childId of element.children ?? []) blocks.push(elementText(context, childId, seen));
  seen.delete(id);
  return blocks.filter((block) => block.length > 0).join('\n\n');
}

function contextOf(view: ResolvedChatView, manifest: ChatComponentManifest, options?: ChatViewTextOptions): Context {
  const locale = options?.locale ?? 'en';
  const markdown = options?.format !== 'plain';
  return {
    view,
    entries: new Map(manifest.components.map((entry) => [entry.id, entry])),
    locale,
    phrases: phrasesOf(locale),
    value: markdown ? escapeChatViewMarkdown : (text) => text,
    markdown,
  };
}

/** The whole view as text (escaped Markdown by default): caption first, then the element tree from the root. */
export function chatViewToText(
  view: ResolvedChatView,
  manifest: ChatComponentManifest,
  options?: ChatViewTextOptions,
): string {
  const context = contextOf(view, manifest, options);
  return [context.value(view.caption ?? ''), elementText(context, view.root, new Set())]
    .filter((block) => block.length > 0)
    .join('\n\n');
}

/** One element and its subtree as text (escaped Markdown by default; no caption); empty for an unknown id. */
export function chatElementToText(
  view: ResolvedChatView,
  elementId: string,
  manifest: ChatComponentManifest,
  options?: ChatViewTextOptions,
): string {
  return elementText(contextOf(view, manifest, options), elementId, new Set());
}
