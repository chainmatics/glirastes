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
import { fillTemplate } from '../utils/fill-template.js';
import { getDefaultUiActionBus, type UiActionBus } from '../../browser/ui-action-bus.js';
import { MentionChip as DefaultMentionChip } from '../components/mention-chip.js';
import { useChatContext } from '../provider/chat-context.js';
import type { Mention } from '../types.js';
import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import {
  collectKnownEntities,
  collectSeenReferenceKeys,
  declaredOutputTypes,
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
 * The declarations `unresolvedMentions` judges a message's markers by: the
 * app's own `entityDeclarations` for every message, and for each assistant
 * message streamed in this page life by a turn that received the server's
 * declarations, that turn's (they win, and never change afterwards).
 */
export interface MentionDeclarationCoverage {
  readonly app?: EntityDeclarationsByTool;
  readonly byMessage: ReadonlyMap<string, EntityDeclarationsByTool>;
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
  /** Per message: the seen keys of the messages up to it, by its declarations; reused while they are the same objects. */
  const prefixKeys = useRef(new Map<string, {
    declarations: EntityDeclarationsByTool;
    searches: unknown;
    prefix: ReadonlyArray<unknown>;
    keys: Set<string>;
  }>());
  const outputTypesOf = useRef(new WeakMap<EntityDeclarationsByTool, Set<string>>());

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
      if (!config || !coverage || !markerMessages || mention.type === 'command') return 'keep';
      // An assistant's marker, of a message whose turn's declarations this page knows.
      if (!message || message.role !== 'assistant') return 'keep';
      const declarations = coverage.byMessage.get(message.id) ?? coverage.app;
      if (!declarations) return 'keep';
      const index = markerMessages.findIndex((entry) => entry.id === message.id);
      if (index < 0) return 'keep';
      // Only what the conversation showed up to this message: a later turn never changes the decision.
      const prefix = markerMessages.slice(0, index + 1);
      let cached = prefixKeys.current.get(message.id);
      if (!cached || cached.declarations !== declarations || cached.searches !== searches
        || cached.prefix.length !== prefix.length || cached.prefix.some((entry, at) => entry !== prefix[at])) {
        cached = { declarations, searches, prefix, keys: collectSeenReferenceKeys(prefix, searches ?? [], declarations) };
        prefixKeys.current.set(message.id, cached);
      }
      if (isSeenReference(cached.keys, mention.type, mention.id)) return 'keep';
      // Entity and declaration types are lower-case: the marker's type is compared case-insensitively, as the seen check does.
      const type = mention.type.toLowerCase();
      let outputTypes = outputTypesOf.current.get(declarations);
      if (!outputTypes) outputTypesOf.current.set(declarations, outputTypes = declaredOutputTypes(declarations));
      const declared = interactions?.entity(type) !== undefined || outputTypes.has(type);
      // Undeclared: as before, unless the declared types are still loading (then never a chip that later goes).
      if (!declared) return interactions?.loading ? 'text' : 'keep';
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
  }, [config, known, seenKeys, unresolvedOn, interactions, searches, coverage, markerMessages, canOpen, open, locale.openEntityLabel]);

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
