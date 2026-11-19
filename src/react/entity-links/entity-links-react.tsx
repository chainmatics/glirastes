import {
  Children,
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { GLIRASTES_NAVIGATE_ACTION_ID } from '../../browser/navigation.js';
import { getDefaultUiActionBus, type UiActionBus } from '../../browser/ui-action-bus.js';
import { MentionChip as DefaultMentionChip } from '../components/mention-chip.js';
import { useChatContext } from '../provider/chat-context.js';
import type { Mention } from '../types.js';
import {
  collectKnownEntities,
  collectSeenReferenceKeys,
  entityNavigationHref,
  isSeenReference,
  splitEntityText,
  type ChatEntityLinksConfig,
  type ChatEntityReference,
  type ChatEntityTextSegment,
} from './entity-links.js';

export interface ChatEntityLinks {
  /** True when `entityLinks` is configured: assistant text is scanned for references. */
  readonly enabled: boolean;
  /** `assistant`: links only in the assistant's text (`entityLinks.scope`). */
  readonly scope?: 'all' | 'assistant';
  split(text: string): ChatEntityTextSegment[];
  /** Whether a chip of this type does something on click. */
  canOpen(type: string): boolean;
  open(reference: ChatEntityReference): void;
  /** Accessible name of a chip's open button (`locale.openEntityLabel`). */
  openLabel(reference: ChatEntityReference): string;
  /** Resolves a matcher hit through its `resolve`, cached per text. */
  resolveMatch(segment: Extract<ChatEntityTextSegment, { kind: 'match' }>): Promise<ChatEntityReference | undefined>;
  /** The cached result of `resolveMatch`, when it is already known. */
  cachedMatch(segment: Extract<ChatEntityTextSegment, { kind: 'match' }>): ChatEntityReference | null | undefined;
  /** Replaces references in the string children with chips. */
  linkify(children: ReactNode): ReactNode;
  /** `react-markdown` `components` that linkify paragraphs, list items, cells and emphasis. */
  readonly markdownComponents: Record<string, (props: Record<string, unknown>) => ReactNode>;
  /** `entityLinks.mentionMarkers`: `'markdown'` keeps Markdown for assistant text with markers. */
  readonly mentionMarkers?: 'plain' | 'markdown';
  /** Whether a marker of the assistant becomes a chip (`entityLinks.verifyMentions`). */
  showsMention(mention: Pick<Mention, 'type' | 'id'>): boolean;
}

const ChatEntityLinksContext = createContext<ChatEntityLinks | null>(null);

const LINKIFIED_TAGS = ['p', 'li', 'td', 'th', 'strong', 'em', 'h1', 'h2', 'h3', 'h4'] as const;

/** Rendered by `AiChatProvider`; reads the conversation and the chat interactions. */
/**
 * Turns entity links off for its children: user messages when
 * `entityLinks.scope` is `assistant`.
 */
export function WithoutEntityLinks({ children }: { children: ReactNode }) {
  return <ChatEntityLinksContext.Provider value={DISABLED_LINKS}>{children}</ChatEntityLinksContext.Provider>;
}

export function ChatEntityLinksProvider({
  config,
  uiActionBus,
  children,
}: {
  config?: ChatEntityLinksConfig;
  uiActionBus?: UiActionBus;
  children: ReactNode;
}) {
  const { messages, interactions, locale, entityDeclarations } = useChatContext();
  const configRef = useRef(config);
  configRef.current = config;
  const busRef = useRef(uiActionBus);
  busRef.current = uiActionBus;
  const cache = useRef(new Map<string, Promise<ChatEntityReference | undefined>>());
  const settled = useRef(new Map<string, ChatEntityReference | null>());
  useEffect(() => {
    cache.current = new Map();
    settled.current = new Map();
  }, [config?.matchers]);

  const knownEnabled = !!config && config.known !== false;
  const searches = interactions?.entitySearches;
  const knownHook = config?.knownEntities;
  const known = useMemo(() => {
    if (!knownEnabled) return [];
    const found = collectKnownEntities(messages, searches ?? [], entityDeclarations);
    if (!knownHook) return found;
    let extra: ReadonlyArray<ChatEntityReference> = [];
    try {
      extra = knownHook({ messages });
    } catch {
      extra = [];
    }
    return [...found, ...extra.filter((reference) => reference && typeof reference.id === 'string' && typeof reference.label === 'string')];
  }, [knownEnabled, messages, searches, entityDeclarations, knownHook]);

  const verify = !!config && config.mentionMarkers === 'markdown' && config.verifyMentions !== false;
  const seenKeys = useMemo(
    () => (verify ? collectSeenReferenceKeys(messages, searches ?? [], entityDeclarations) : undefined),
    [verify, messages, searches, entityDeclarations],
  );

  const canOpen = useCallback((type: string) => {
    const current = configRef.current;
    if (current?.open && (current.canOpen?.(type) ?? true)) return true;
    return entityNavigationHref(interactions?.entity(type), 'id') !== undefined;
  }, [interactions]);

  const open = useCallback((reference: ChatEntityReference) => {
    const current = configRef.current;
    if (current?.open && (current.canOpen?.(reference.type) ?? true) && current.open(reference) !== false) return;
    const href = entityNavigationHref(interactions?.entity(reference.type), reference.id);
    if (!href) return;
    void (busRef.current ?? getDefaultUiActionBus()).dispatch({
      type: 'glirastes.navigate',
      actionId: GLIRASTES_NAVIGATE_ACTION_ID,
      payload: { href },
    });
  }, [interactions]);

  const value = useMemo<ChatEntityLinks>(() => {
    const matchers = config?.matchers ?? [];
    const keyOf = (segment: { matcher: number; text: string; match?: string }) => `${segment.matcher}\u0000${segment.match ?? segment.text}`;
    const links: ChatEntityLinks = {
      enabled: !!config,
      ...(config?.scope ? { scope: config.scope } : {}),
      split: (text) => (config
        ? splitEntityText(text, {
          matchers,
          known,
          minLabelLength: config.minLabelLength,
          ...(config.ambiguousNames ? { ambiguousNames: config.ambiguousNames } : {}),
          ...(config.resolveAmbiguous ? { resolveAmbiguous: config.resolveAmbiguous } : {}),
        })
        : [{ kind: 'text', text }]),
      canOpen,
      open,
      openLabel: (reference) => locale.openEntityLabel.replace('{label}', reference.label),
      cachedMatch: (segment) => settled.current.get(keyOf(segment)),
      resolveMatch(segment) {
        const key = keyOf(segment);
        const hit = segment.match ?? segment.text;
        let pending = cache.current.get(key);
        if (!pending) {
          const matcher = matchers[segment.matcher];
          pending = Promise.resolve()
            .then(() => (matcher?.resolve ? matcher.resolve(hit) : { id: hit, label: hit }))
            .then((found) => (found && typeof found.id === 'string' && found.id
              ? {
                type: segment.type,
                id: found.id,
                label: typeof found.label === 'string' && found.label ? found.label : hit,
                ...(found.data && typeof found.data === 'object' ? { data: found.data } : {}),
              }
              : undefined))
            .catch(() => {
              cache.current.delete(key);
              return undefined;
            });
          pending.then((reference) => { settled.current.set(key, reference ?? null); });
          cache.current.set(key, pending);
        }
        return pending;
      },
      linkify: (children) => linkifyChildren(children, links),
      markdownComponents: {},
      ...(config?.mentionMarkers ? { mentionMarkers: config.mentionMarkers } : {}),
      showsMention: (mention) => mention.type === 'command' || !seenKeys || isSeenReference(seenKeys, mention.type, mention.id),
    };
    (links as { markdownComponents: ChatEntityLinks['markdownComponents'] }).markdownComponents = Object.fromEntries(
      LINKIFIED_TAGS.map((tag) => [tag, ({ node: _node, children, ...props }: Record<string, unknown>) =>
        createElement(tag, props, linkifyChildren(children as ReactNode, links))]),
    );
    return links;
  }, [config, known, seenKeys, canOpen, open, locale.openEntityLabel]);

  return <ChatEntityLinksContext.Provider value={value}>{children}</ChatEntityLinksContext.Provider>;
}

const DISABLED_LINKS: ChatEntityLinks = {
  enabled: false,
  split: (text) => [{ kind: 'text', text }],
  canOpen: () => false,
  open: () => {},
  openLabel: (reference) => reference.label,
  resolveMatch: async () => undefined,
  cachedMatch: () => undefined,
  linkify: (children) => children,
  markdownComponents: {},
  showsMention: () => true,
};

/**
 * Entity chips for assistant text; use `linkify` or `markdownComponents` in a
 * custom `Markdown` component. Outside `AiChatProvider` nothing is linked.
 */
export function useChatEntityLinks(): ChatEntityLinks {
  return useContext(ChatEntityLinksContext) ?? DISABLED_LINKS;
}

function linkifyChildren(children: ReactNode, links: ChatEntityLinks): ReactNode {
  if (!links.enabled) return children;
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    // A marker kept inside Markdown (`mentionMarkers: 'markdown'`).
    if (child.includes(MARKER_EDGE)) return <MarkerText text={child} />;
    const segments = links.split(child);
    if (segments.length === 1 && segments[0]!.kind === 'text') return child;
    return <EntityTextSegments segments={segments} />;
  });
}

function EntityTextSegments({ segments }: { segments: ChatEntityTextSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment.kind === 'text'
            ? segment.text
            : segment.kind === 'entity'
              ? <EntityLinkChip reference={segment.reference} text={segment.text} />
              : <MatchedEntityChip segment={segment} />}
        </Fragment>
      ))}
    </>
  );
}

/** Text with the references `entityLinks` recognises rendered as chips. */
export function EntityText({ text }: { text: string }) {
  const links = useChatEntityLinks();
  const segments = useMemo(() => links.split(text), [links, text]);
  return <EntityTextSegments segments={segments} />;
}

function MatchedEntityChip({ segment }: { segment: Extract<ChatEntityTextSegment, { kind: 'match' }> }) {
  const links = useChatEntityLinks();
  const [reference, setReference] = useState<ChatEntityReference | null | undefined>(() => links.cachedMatch(segment));
  useEffect(() => {
    if (reference !== undefined) return;
    let live = true;
    void links.resolveMatch(segment).then((found) => { if (live) setReference(found ?? null); });
    return () => { live = false; };
  }, [links, segment, reference]);
  if (!reference) return <>{segment.text}</>;
  return <EntityLinkChip reference={reference} text={segment.text} />;
}

/**
 * One reference as a chip (the app's `components.MentionChip` when set),
 * clickable when the entity can be opened.
 */
export function EntityLinkChip({ reference, text }: { reference: ChatEntityReference; text?: string }) {
  const links = useChatEntityLinks();
  const { components } = useChatContext();
  const Chip = components.MentionChip ?? DefaultMentionChip;
  const openable = links.canOpen(reference.type);
  return (
    <Chip
      mention={{ id: reference.id, type: reference.type, displayName: text ?? reference.label, prefix: '', label: reference.label }}
      inline
      {...(openable ? { onOpen: () => links.open(reference), openLabel: links.openLabel(reference) } : {})}
    />
  );
}

/** Encloses the label of a marker kept in Markdown text: a word joiner, invisible where nothing renders a chip. */
const MARKER_EDGE = '\u2060';
const MARKER_SPAN = /\u2060([^\u2060]*)\u2060/g;
const MARKDOWN_PUNCTUATION = /[\\`*_{}[\]()#+\-.!<>|~]/g;

/** The markers of one text part, in the order they occur. */
const MentionMarkersContext = createContext<ReadonlyArray<Mention> | null>(null);

/**
 * The text of a part with markers for Markdown (`mentionMarkers:
 * 'markdown'`): each marker becomes its label between word joiners (its
 * Markdown characters escaped), so a Markdown renderer keeps the label as
 * one plain text and `markdownComponents` turn it into a chip.
 */
export function markdownWithMentionMarkers(
  segments: ReadonlyArray<{ kind: 'text'; text: string } | { kind: 'mention'; mention: Mention }>,
): { content: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  let content = '';
  for (const segment of segments) {
    if (segment.kind === 'text') {
      content += segment.text.replaceAll(MARKER_EDGE, '');
      continue;
    }
    mentions.push(segment.mention);
    const label = segment.mention.displayName.replaceAll(MARKER_EDGE, '').replace(MARKDOWN_PUNCTUATION, (char) => `\\${char}`);
    content += `${MARKER_EDGE}${label}${MARKER_EDGE}`;
  }
  return { content, mentions };
}

/** Gives the markers of a text part to the chips Markdown renders inside it. */
export function MentionMarkers({ mentions, children }: { mentions: ReadonlyArray<Mention>; children: ReactNode }) {
  return <MentionMarkersContext.Provider value={mentions}>{children}</MentionMarkersContext.Provider>;
}

/** A Markdown text with marker labels: each one a chip (when shown), the rest linked as before. */
function MarkerText({ text }: { text: string }) {
  const links = useChatEntityLinks();
  const mentions = useContext(MentionMarkersContext) ?? [];
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const plain = (value: string, key: string) => {
    if (!value) return;
    const segments = links.split(value);
    nodes.push(segments.length === 1 && segments[0]!.kind === 'text'
      ? <Fragment key={key}>{value}</Fragment>
      : <EntityTextSegments key={key} segments={segments} />);
  };
  for (const found of text.matchAll(MARKER_SPAN)) {
    plain(text.slice(cursor, found.index), `t${cursor}`);
    const label = found[1] ?? '';
    const mention = mentions.find((candidate) => candidate.displayName.replaceAll(MARKER_EDGE, '') === label);
    nodes.push(mention && links.showsMention(mention)
      ? <MarkerChip key={`m${found.index}`} mention={mention} />
      : <Fragment key={`m${found.index}`}>{label}</Fragment>);
    cursor = found.index + found[0].length;
  }
  plain(text.slice(cursor), `t${cursor}`);
  return <>{nodes}</>;
}

function MarkerChip({ mention }: { mention: Mention }) {
  const links = useChatEntityLinks();
  const { components } = useChatContext();
  const Chip = components.MentionChip ?? DefaultMentionChip;
  const reference = { type: mention.type, id: mention.id, label: mention.displayName };
  return (
    <Chip
      mention={mention}
      inline
      {...(mention.type !== 'command' && links.canOpen(mention.type)
        ? { onOpen: () => links.open(reference), openLabel: links.openLabel(reference) }
        : {})}
    />
  );
}
