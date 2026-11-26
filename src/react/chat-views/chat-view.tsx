import { Fragment, type ReactNode } from 'react';
import {
  RENDER_VIEW_TOOL_NAME,
  resolvedChatViewSchema,
  type ResolvedChatView,
} from '../../contracts/chat-view.js';
import { starterChatComponentManifest } from '../../chat-views/starter-catalog.js';
import { chatElementToText, chatViewPhrasesOf, chatViewToText } from '../../chat-views/text.js';
import { RESOLVED_TABLE_NOTE_PROPS } from '../../chat-views/validate.js';
import { RendererBoundary } from '../tool-renderers/renderer-boundary.js';
import type { ChatViewDispatch, ChatViewRegistry } from './registry.js';

/** The SDK's own texts in a view. `more` fills in `{count}`. */
export interface ChatViewTexts {
  /** Next to a value the assistant stated (`$said`). */
  said: string;
  /** Under a table whose source was a cut or an overview. */
  partial: string;
  /** Under a table with rows left out, e.g. `+{count} more`. */
  more: string;
}

export interface ChatViewProps {
  view: ResolvedChatView;
  /** The bound components; without one the whole view renders as text. */
  registry?: ChatViewRegistry;
  /** BCP 47 language for numbers, money, dates and the default texts; default `en`. */
  locale?: string;
  texts?: Partial<ChatViewTexts>;
  dispatch?: Partial<ChatViewDispatch>;
  /** Renders the Markdown text of a whole view that cannot render as components. */
  renderText?: (markdown: string) => ReactNode;
}

type Element = ResolvedChatView['elements'][string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function elementOf(view: ResolvedChatView, id: string): Element | undefined {
  return Object.prototype.hasOwnProperty.call(view.elements, id) ? view.elements[id] : undefined;
}

const NO_DISPATCH: ChatViewDispatch = { prompt: () => {}, uiAction: () => {} };

function plainText(text: string): ReactNode {
  return <div data-element="text-fallback">{text}</div>;
}

/**
 * A resolved chat view through the bound components. An element whose
 * component is not bound (or not in its version) or whose props do not fit
 * renders as its text; a root that cannot render, or a binding that throws at
 * the root, renders the whole view as text.
 */
export function ChatView({ view, registry, locale = 'en', texts, dispatch, renderText = plainText }: ChatViewProps) {
  const manifest = registry?.manifest ?? starterChatComponentManifest;
  const phrases = chatViewPhrasesOf(locale);
  const said = texts?.said ?? phrases.said;
  const partial = texts?.partial ?? phrases.partial;
  const more = texts?.more ?? phrases.more;
  const actions: ChatViewDispatch = { ...NO_DISPATCH, ...dispatch };
  const wholeText = (
    <div data-component="chat-view" data-fallback="text">
      {renderText(chatViewToText(view, manifest, { locale }))}
    </div>
  );
  const root = elementOf(view, view.root);
  if (!registry || !root || !registry.resolve(root.type, root.schemaVersion, root.props)) return wholeText;

  const elementText = (target: ResolvedChatView, id: string) => (
    <span data-element="text-fallback">{chatElementToText(target, id, manifest, { locale })}</span>
  );

  function renderCell(tableId: string, rowIndex: number, cellId: string): ReactNode {
    const row = elementOf(view, tableId)?.rows?.[rowIndex];
    const cell = elementOf(view, cellId);
    const props = row && Object.prototype.hasOwnProperty.call(row, cellId) ? row[cellId] : undefined;
    if (!cell || !isRecord(props)) return null;
    const resolved = registry!.resolve(cell.type, cell.schemaVersion, props);
    const fallback = () => elementText({ ...view, elements: { ...view.elements, [cellId]: { ...cell, props } } }, cellId);
    if (!resolved) return fallback();
    const Component = resolved.binding.component;
    return (
      <RendererBoundary fallback={fallback()}>
        <Component props={props} renderCell={() => null} locale={locale} dispatch={actions} />
      </RendererBoundary>
    );
  }

  function renderElement(id: string, ancestors: ReadonlySet<string>): ReactNode {
    const element = elementOf(view, id);
    if (!element || ancestors.has(id)) return null;
    const resolved = registry!.resolve(element.type, element.schemaVersion, element.props);
    if (!resolved) return elementText(view, id);
    const inside = new Set(ancestors).add(id);
    const children = element.children?.length
      ? element.children.map((childId) => <Fragment key={childId}>{renderElement(childId, inside)}</Fragment>)
      : undefined;
    // The server's notes on a table are the SDK's to show, not props of the app's component.
    let props = element.props;
    const notes: ReactNode[] = [];
    if (resolved.entry.itemScope) {
      props = Object.fromEntries(
        Object.entries(element.props).filter(([key]) => !(RESOLVED_TABLE_NOTE_PROPS as readonly string[]).includes(key)),
      );
      const truncated = element.props.truncatedRows;
      if (typeof truncated === 'number' && truncated > 0) {
        notes.push(<p key="more" data-element="table-note" data-note="more">{more.replace('{count}', String(truncated))}</p>);
      }
      if (element.props.partial === true) {
        notes.push(<p key="partial" data-element="table-note" data-note="partial">{partial}</p>);
      }
    }
    const Component = resolved.binding.component;
    return (
      <RendererBoundary fallback={elementText(view, id)}>
        <Component
          props={props}
          {...(element.said ? { said: true } : {})}
          {...(element.rows ? { rows: element.rows } : {})}
          renderCell={(rowIndex: number, cellId: string) => renderCell(id, rowIndex, cellId)}
          locale={locale}
          dispatch={actions}
        >
          {children}
        </Component>
        {/* SDK-owned: a stated value is marked whatever the app's component or styles do. */}
        {element.said ? <>{' '}<span data-element="said-marker">{said}</span></> : null}
        {notes}
      </RendererBoundary>
    );
  }

  return (
    <RendererBoundary fallback={wholeText}>
      <div data-component="chat-view">
        {view.caption ? <p data-element="caption">{view.caption}</p> : null}
        {renderElement(view.root, new Set())}
      </div>
    </RendererBoundary>
  );
}

export interface ChatViewPart {
  toolCallId: string;
  /** The resolved view of a successful call; absent while it runs, for a failure or an unreadable view. */
  view?: ResolvedChatView;
}

const parsedViews = new WeakMap<object, ResolvedChatView | null>();

function parseView(output: Record<string, unknown>): ResolvedChatView | undefined {
  const cached = parsedViews.get(output);
  if (cached !== undefined) return cached ?? undefined;
  const parsed = output.shown === true ? resolvedChatViewSchema.safeParse(output.view) : undefined;
  const view = parsed?.success ? parsed.data : null;
  parsedViews.set(output, view);
  return view ?? undefined;
}

/** Reads a `render_view` tool part (AI SDK 5/6 UI messages, or a `toolName`/`result` part). */
export function readChatViewPart(part: unknown): ChatViewPart | undefined {
  if (!isRecord(part)) return undefined;
  const isView = part.type === `tool-${RENDER_VIEW_TOOL_NAME}`
    || ((part.type === 'dynamic-tool' || 'result' in part) && part.toolName === RENDER_VIEW_TOOL_NAME);
  if (!isView) return undefined;
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
  const output = part.state === 'output-available' ? part.output : 'result' in part ? part.result : undefined;
  const view = isRecord(output) ? parseView(output) : undefined;
  return view ? { toolCallId, view } : { toolCallId };
}
