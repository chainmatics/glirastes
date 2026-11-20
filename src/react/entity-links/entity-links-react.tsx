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
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { GLIRASTES_NAVIGATE_ACTION_ID } from '../../browser/navigation.js';
import { fillTemplate } from '../utils/fill-template.js';
import { getDefaultUiActionBus, type UiActionBus } from '../../browser/ui-action-bus.js';
import { MentionChip as DefaultMentionChip } from '../components/mention-chip.js';
import { useChatContext } from '../provider/chat-context.js';
import type { Mention } from '../types.js';
import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import { hasPendingChatInteractionsLoad, subscribeChatInteractionsLoads } from '../interactions/use-chat-interactions-data.js';

const noSubscription = () => () => {};
const noPendingLoad = () => false;
import {
  collectKnownEntities,
  collectSeenReferenceKeys,
  declaredOutputTypes,
  indexSeenReferences,
  isSeenBy,
  entityNavigationHref,
  isSeenReference,
  isUnresolvedMentionPolicy,
  splitEntityText,
  type ChatEntityLinksConfig,
  type ChatEntityReference,
  type ChatEntityTextSegment,
  type ChatUnresolvedMentionPolicy,
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
  showsMention(mention: Mention): boolean;
  /**
   * `entityLinks.unresolvedMentions` (and its hook) for a marker
   * of `message`: `'keep'` for a user's marker, a marker of a turn whose
   * declarations this page does not know, one whose id the conversation
   * showed, of an undeclared type, a command, or without the option.
   */
  unresolvedMention?(mention: Mention, message?: MentionMarkerMessage): ChatUnresolvedMentionPolicy;
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

/**
 * The declarations `unresolvedMentions` reads a message by: the app's own
 * `entityDeclarations` (live), merged over the server's declarations of the
 * turn that streamed the message in this page life, when it has them. An
 * entry of another `generation` (a left history) does not count.
 */
export interface MentionDeclarationCoverage {
  readonly app?: EntityDeclarationsByTool;
  readonly byMessage: ReadonlyMap<string, { readonly declarations: EntityDeclarationsByTool; readonly generation: number }>;
  readonly generation: number;
}

/** The message a marker belongs to: its id and role. */
export interface MentionMarkerMessage {
  readonly id: string;
  readonly role: string;
}

export function ChatEntityLinksProvider({
  config,
  uiActionBus,
  declarationCoverage,
  children,
}: {
  config?: ChatEntityLinksConfig;
  uiActionBus?: UiActionBus;
  declarationCoverage?: MentionDeclarationCoverage;
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
  // Only an app that sets `unresolvedMentions` (other than `keep`) or its hook judges markers.
  const unresolvedOn = !!config && ((config.unresolvedMentions !== undefined && config.unresolvedMentions !== 'keep')
    || typeof config.unresolvedMention === 'function');
  // Without the option the links do not depend on these (as before).
  const coverage = unresolvedOn ? declarationCoverage : undefined;
  const markerMessages = unresolvedOn ? messages : undefined;
  const outputTypesOf = useRef(new WeakMap<EntityDeclarationsByTool, Set<string>>());
  /** The server's declarations of a turn merged with the app's, one object per pair (so caches can compare them). */
  const mergedOf = useRef(new WeakMap<EntityDeclarationsByTool, { app: EntityDeclarationsByTool | undefined; merged: EntityDeclarationsByTool }>());
  /** What each message object contributes, while its declarations and searches stay the same (weak: a left chat goes). */
  const messageKeys = useRef(new WeakMap<object, never>());
  const declarationsOf = useCallback((message: { id?: string } | undefined): EntityDeclarationsByTool | undefined => {
    if (!coverage || !message || typeof message.id !== 'string') return undefined;
    const entry = coverage.byMessage.get(message.id);
    const server = entry && entry.generation === coverage.generation ? entry.declarations : undefined;
    if (!server) return coverage.app;
    if (!coverage.app) return server;
    let found = mergedOf.current.get(server);
    // The app's own win per tool, as in the declarations the chat uses.
    if (!found || found.app !== coverage.app) mergedOf.current.set(server, found = { app: coverage.app, merged: { ...server, ...coverage.app } });
    return found.merged;
  }, [coverage]);
  // One pass per conversation: where each reference was first shown, each tool result read by its own message's declarations.
  const seenIndex = useMemo(
    () => (coverage && markerMessages
      ? indexSeenReferences(markerMessages, searches ?? [], (index) => declarationsOf(markerMessages[index]), messageKeys.current as WeakMap<object, never>)
      : undefined),
    [coverage, markerMessages, searches, declarationsOf],
  );
  // Default of `chatInteractions.loading`: `data` given as `undefined` while a load of it still waits.
  const loadPending = useSyncExternalStore(
    unresolvedOn ? subscribeChatInteractionsLoads : noSubscription,
    unresolvedOn ? hasPendingChatInteractionsLoad : noPendingLoad,
    noPendingLoad,
  );
  const interactionsLoading = interactions?.loading ?? (!!interactions?.awaitsData && loadPending);

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
    /** `unresolvedMentions`: the policy of a marker, by the declarations and messages of its own turn. */
    const unresolvedMention = (mention: Mention, message?: MentionMarkerMessage): ChatUnresolvedMentionPolicy => {
      if (!config || !seenIndex || !markerMessages || mention.type === 'command') return 'keep';
      // An assistant's marker, of a message with declarations to read it by.
      if (!message || message.role !== 'assistant') return 'keep';
      const index = seenIndex.indexOf.get(message.id);
      if (index === undefined) return 'keep';
      const declarations = declarationsOf(markerMessages[index]);
      if (!declarations) return 'keep';
      // A tool result up to this message that nothing can read might have shown the id: not judged.
      if (seenIndex.firstUnreadable <= index) return 'keep';
      // Only what the conversation showed up to this message: a later turn never changes the decision.
      if (isSeenBy(seenIndex, index, mention.type, mention.id)) return 'keep';
      // Entity and declaration types are lower-case: the marker's type is compared case-insensitively, as the seen check does.
      const type = mention.type.toLowerCase();
      let outputTypes = outputTypesOf.current.get(declarations);
      if (!outputTypes) outputTypesOf.current.set(declarations, outputTypes = declaredOutputTypes(declarations));
      const declared = interactions?.entity(type) !== undefined || outputTypes.has(type);
      // Undeclared: as before, unless the declared types are still loading (then never a chip that later goes).
      if (!declared) return interactionsLoading ? 'text' : 'keep';
      let decided: unknown;
      try {
        decided = config.unresolvedMention?.({ type: mention.type, id: mention.id, label: mention.displayName });
      } catch {
        decided = undefined;
      }
      if (isUnresolvedMentionPolicy(decided)) return decided;
      return isUnresolvedMentionPolicy(config.unresolvedMentions) ? config.unresolvedMentions : 'keep';
    };
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
      openLabel: (reference) => fillTemplate(locale.openEntityLabel, { label: reference.label }),
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
      // A marker names its record by id: another record with the same name does not matter (`ambiguousNames`
      // and `resolveAmbiguous` decide name matches only); `verifyMentions` still applies.
      showsMention: (mention) => {
        if (mention.type === 'command') return true;
        return !seenKeys || isSeenReference(seenKeys, mention.type, mention.id);
      },
      ...(unresolvedOn ? { unresolvedMention } : {}),
    };
    (links as { markdownComponents: ChatEntityLinks['markdownComponents'] }).markdownComponents = Object.fromEntries(
      LINKIFIED_TAGS.map((tag) => [tag, ({ node: _node, children, ...props }: Record<string, unknown>) =>
        createElement(tag, props, linkifyChildren(children as ReactNode, links))]),
    );
    return links;
  }, [config, known, seenKeys, unresolvedOn, interactions, seenIndex, markerMessages, declarationsOf, interactionsLoading, canOpen, open, locale.openEntityLabel]);

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

/**
 * A marker kept in Markdown text: `\u2060`, its index in zero-width digits
 * (`\u200B` 0, `\u200C` 1), `\u2063`, its label, `\u2060`. Invisible where
 * nothing renders a chip; the index keeps markers with one label apart.
 */
const MARKER_EDGE = '\u2060';
const MARKER_SPAN = /\u2060([\u200B\u200C]+)\u2063([^\u2060]*)\u2060/g;
const MARKER_CHARS = /[\u2060\u2063]/g;

function markerIndexText(index: number): string {
  return index.toString(2).replace(/0/g, '\u200B').replace(/1/g, '\u200C');
}

function markerIndexOf(text: string): number {
  return Number.parseInt(text.replace(/\u200B/g, '0').replace(/\u200C/g, '1'), 2);
}
const MARKDOWN_PUNCTUATION = /[\\`*_{}[\]()#+\-.!<>|~]/g;

/** The markers of one text part, in the order they occur, and the message they belong to. */
const MentionMarkersContext = createContext<{ mentions: ReadonlyArray<Mention>; message?: MentionMarkerMessage } | null>(null);

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
      content += segment.text.replace(MARKER_CHARS, '');
      continue;
    }
    const index = mentions.push(segment.mention) - 1;
    const label = segment.mention.displayName.replace(MARKER_CHARS, '').replace(MARKDOWN_PUNCTUATION, (char) => `\\${char}`);
    content += `${MARKER_EDGE}${markerIndexText(index)}\u2063${label}${MARKER_EDGE}`;
  }
  return { content, mentions };
}

/**
 * Gives the markers of a text part to the chips Markdown renders inside it.
 * `message` (its id and role) lets `entityLinks.unresolvedMentions` judge
 * them; without it they render as before.
 */
export function MentionMarkers({ mentions, message, children }: {
  mentions: ReadonlyArray<Mention>;
  message?: MentionMarkerMessage;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ mentions, ...(message ? { message } : {}) }), [mentions, message?.id, message?.role]);
  return <MentionMarkersContext.Provider value={value}>{children}</MentionMarkersContext.Provider>;
}

/** A Markdown text with marker labels: each one a chip (when shown), the rest linked as before. */
function MarkerText({ text }: { text: string }) {
  const links = useChatEntityLinks();
  const markers = useContext(MentionMarkersContext);
  const mentions = markers?.mentions ?? [];
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
    const label = found[2] ?? '';
    const mention = mentions[markerIndexOf(found[1] ?? '')];
    const policy = mention ? links.unresolvedMention?.(mention, markers?.message) ?? 'keep' : 'keep';
    nodes.push(mention && policy === 'text'
      ? <Fragment key={`m${found.index}`}>{label}</Fragment>
      : mention && links.showsMention(mention)
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
