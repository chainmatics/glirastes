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
import { CHAT_ENTITY_ITEM_TEXT_MAX, type ChatEntityItem } from '../interactions/definitions.js';
import { parseMentionSegments } from '../utils/mention-markup.js';
import {
  collectKnownEntities,
  collectSeenReferenceKeys,
  declaredOutputTypes,
  entityNavigationHref,
  isSeenReference,
  isUnresolvedMentionPolicy,
  pickExactNameMatch,
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
   * `entityLinks.unresolvedMentions` (and its hook and bounds) for a marker
   * of `message`: `'keep'` for a user's marker, a marker of a turn whose
   * declarations this page does not know, one whose id the conversation
   * showed, of an undeclared type, a command, or without the option.
   */
  unresolvedMention?(mention: Mention, message?: MentionMarkerMessage): ChatUnresolvedMentionPolicy;
  /** Looks a marker up by name for `'search'`: the one exact match, cached per type and name; `undefined` for none or a failure. */
  searchMention?(mention: Mention): Promise<ChatEntityReference | undefined>;
  /** The settled result of `searchMention` (`null`: no match), `undefined` while unknown or after a failure. */
  cachedMention?(mention: Mention): ChatEntityReference | null | undefined;
  /** Identifies a marker's search: its type, name and the user context. */
  mentionSearchKey?(mention: Mention): string;
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
 * Which messages' markers `unresolvedMentions` may judge: every message when
 * the app passes `entityDeclarations` itself, else only the assistant
 * messages of turns that received the server's declarations in this page life.
 */
export interface MentionDeclarationCoverage {
  readonly all: boolean;
  readonly messageIds: ReadonlySet<string>;
}

/** The message a marker belongs to. */
export interface MentionMarkerMessage {
  readonly id: string;
  readonly role: string;
}

/** Distinct names `'search'` looks up per message by default (`maxMentionSearches`). */
export const DEFAULT_MAX_MENTION_SEARCHES = 5;
/** Searches that run at once, per provider. */
export const MENTION_SEARCH_CONCURRENCY = 2;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function comparableMentionName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function ChatEntityLinksProvider({
  config,
  uiActionBus,
  completionContext,
  declarationCoverage,
  children,
}: {
  config?: ChatEntityLinksConfig;
  uiActionBus?: UiActionBus;
  /** The user context entity searches get; it keys the `'search'` cache by value. */
  completionContext?: unknown;
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
  // Only an app that sets `unresolvedMentions` (other than `keep`) or its hook checks plain markers.
  const unresolvedOn = !!config && ((config.unresolvedMentions !== undefined && config.unresolvedMentions !== 'keep')
    || typeof config.unresolvedMention === 'function');
  const checkedKeys = useMemo(
    () => (verify || unresolvedOn ? collectSeenReferenceKeys(messages, searches ?? [], entityDeclarations) : undefined),
    [verify, unresolvedOn, messages, searches, entityDeclarations],
  );
  const seenKeys = verify ? checkedKeys : undefined;
  const outputTypes = useMemo(
    () => (unresolvedOn ? declaredOutputTypes(entityDeclarations) : undefined),
    [unresolvedOn, entityDeclarations],
  );
  // Without the option the links do not depend on these (as before).
  const coverage = unresolvedOn ? declarationCoverage : undefined;
  const markerMessages = unresolvedOn ? messages : undefined;
  const interactionsRef = useRef(interactions);
  interactionsRef.current = interactions;
  // One search per type and name while the user context stays the same by value; never a failed one.
  const contextKey = unresolvedOn ? stableJson(completionContext ?? {}) : '';
  const searchCache = useRef<{
    contextKey: string;
    pending: Map<string, Promise<ChatEntityReference | undefined>>;
    settled: Map<string, ChatEntityReference | null>;
  } | null>(null);
  if (!searchCache.current || searchCache.current.contextKey !== contextKey) {
    searchCache.current = { contextKey, pending: new Map(), settled: new Map() };
  }
  const searchSlots = useRef({ running: 0, waiting: [] as Array<() => void> });

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
    /** `unresolvedMentions`: the policy of a marker, the search by name and its bounds. */
    function unresolvedMentionLinks(): Pick<ChatEntityLinks, 'unresolvedMention' | 'searchMention' | 'cachedMention' | 'mentionSearchKey'> {
      const cache = searchCache.current!;
      const maxSearches = typeof config?.maxMentionSearches === 'number' && config.maxMentionSearches >= 0
        ? Math.floor(config.maxMentionSearches)
        : DEFAULT_MAX_MENTION_SEARCHES;
      const nameKey = (mention: Mention) => `${mention.type.toLowerCase()}\u0000${comparableMentionName(mention.displayName)}`;
      /** The policy before the search bounds. */
      const policyOf = (mention: Mention, message: MentionMarkerMessage | undefined): ChatUnresolvedMentionPolicy => {
        if (!config || !checkedKeys || mention.type === 'command') return 'keep';
        // An assistant's marker, of a turn whose declarations this page knows.
        if (!message || message.role !== 'assistant') return 'keep';
        if (!coverage || !(coverage.all || coverage.messageIds.has(message.id))) return 'keep';
        if (isSeenReference(checkedKeys, mention.type, mention.id)) return 'keep';
        // Entity and declaration types are lower-case: the marker's type is compared case-insensitively, as the seen check does.
        const type = mention.type.toLowerCase();
        const declared = interactions?.entity(type) !== undefined || !!outputTypes?.has(type);
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
      const searchable = (mention: Mention) => {
        const name = comparableMentionName(mention.displayName);
        return name.length > 0 && name.length < CHAT_ENTITY_ITEM_TEXT_MAX;
      };
      /** Per message: its distinct searched names in marker order. */
      const orders = new Map<string, string[]>();
      const searchOrder = (message: MentionMarkerMessage): string[] => {
        let order = orders.get(message.id);
        if (order) return order;
        order = [];
        const found = markerMessages?.find((entry) => (entry as { id?: unknown }).id === message.id);
        for (const part of found?.parts ?? []) {
          const text = (part as { type?: unknown; text?: unknown });
          if (text.type !== 'text' || typeof text.text !== 'string') continue;
          for (const segment of parseMentionSegments(text.text)) {
            if (segment.kind !== 'mention' || !searchable(segment.mention)) continue;
            if (policyOf(segment.mention, message) !== 'search') continue;
            const key = nameKey(segment.mention);
            if (!order.includes(key)) order.push(key);
          }
        }
        orders.set(message.id, order);
        return order;
      };
      const slots = searchSlots.current;
      const inSlot = <T,>(run: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
        const start = () => {
          slots.running += 1;
          run().then(resolve, reject).finally(() => {
            slots.running -= 1;
            slots.waiting.shift()?.();
          });
        };
        if (slots.running < MENTION_SEARCH_CONCURRENCY) start();
        else slots.waiting.push(start);
      });
      return {
        unresolvedMention: (mention, message) => {
          const policy = policyOf(mention, message);
          if (policy !== 'search') return policy;
          if (!searchable(mention)) return 'text';
          const index = searchOrder(message!).indexOf(nameKey(mention));
          return index >= 0 && index < maxSearches ? 'search' : 'text';
        },
        mentionSearchKey: (mention) => `${cache.contextKey}\u0001${nameKey(mention)}`,
        cachedMention: (mention) => cache.settled.get(nameKey(mention)),
        searchMention(mention) {
          const key = nameKey(mention);
          const settledHit = cache.settled.get(key);
          if (settledHit !== undefined) return Promise.resolve(settledHit ?? undefined);
          let pending = cache.pending.get(key);
          if (!pending) {
            const type = mention.type.toLowerCase();
            const name = mention.displayName;
            const query = comparableMentionName(name);
            // The entity's own search, with the user's session: what the user may see, the app decides.
            pending = inSlot(async () => {
              const registry = interactionsRef.current;
              if (!registry?.entity(type) || !searchable(mention)) return [] as ChatEntityItem[];
              const signal = new AbortController().signal;
              return registry.trySearchEntity
                ? registry.trySearchEntity(type, query, signal)
                : registry.searchEntity(type, query, signal);
            }).then((items) => {
              if (items === undefined) {
                // A failure is not "no match": the next marker with this name searches again.
                cache.pending.delete(key);
                return undefined;
              }
              // A label at the cut length may be longer than shown: never an exact match.
              const whole = items.filter((item) => typeof item.label === 'string' && item.label.length < CHAT_ENTITY_ITEM_TEXT_MAX);
              const hit = pickExactNameMatch(name, whole);
              const reference = hit ? { type, id: hit.id, label: name } : undefined;
              cache.settled.set(key, reference ?? null);
              return reference;
            }, () => {
              cache.pending.delete(key);
              return undefined;
            });
            cache.pending.set(key, pending);
          }
          return pending;
        },
      };
    }

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
      ...(unresolvedOn ? unresolvedMentionLinks() : {}),
    };
    (links as { markdownComponents: ChatEntityLinks['markdownComponents'] }).markdownComponents = Object.fromEntries(
      LINKIFIED_TAGS.map((tag) => [tag, ({ node: _node, children, ...props }: Record<string, unknown>) =>
        createElement(tag, props, linkifyChildren(children as ReactNode, links))]),
    );
    return links;
  }, [config, known, seenKeys, checkedKeys, unresolvedOn, outputTypes, interactions, coverage, markerMessages, contextKey, canOpen, open, locale.openEntityLabel]);

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
    nodes.push(mention && policy !== 'keep'
      ? <UnresolvedMentionMarker key={`m${found.index}`} mention={mention} policy={policy} text={label} />
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

/**
 * An assistant's marker `entityLinks.unresolvedMentions` applies to: `text`
 * renders its name; `search` its name until the search found exactly one
 * record with that name, then a chip with that record's id. For a custom
 * bubble: render it where `useChatEntityLinks().unresolvedMention(mention,
 * message)` is not `'keep'`.
 */
export function UnresolvedMentionMarker({ mention, policy, text }: {
  mention: Mention;
  policy: Exclude<ChatUnresolvedMentionPolicy, 'keep'>;
  /** What shows instead of a chip; default the marker's name. */
  text?: string;
}) {
  const links = useChatEntityLinks();
  const searching = policy === 'search' && !!links.searchMention;
  const key = searching ? links.mentionSearchKey?.(mention) ?? '' : '';
  // A result belongs to the type, name and user context it was found for.
  const [found, setFound] = useState<{ key: string; reference: ChatEntityReference | null } | undefined>(undefined);
  const reference = found && found.key === key ? found.reference : (searching ? links.cachedMention?.(mention) : null);
  const { type, id, displayName } = mention;
  useEffect(() => {
    if (!searching || reference !== undefined) return;
    let live = true;
    void links.searchMention!({ ...mention, type, id, displayName }).then((hit) => {
      if (live) setFound({ key, reference: hit ?? null });
    });
    return () => { live = false; };
    // The marker's fields, not its object: a re-render parses a new one.
  }, [links, searching, key, type, id, displayName, reference]);
  if (!searching || !reference) return <>{text ?? displayName}</>;
  return <MarkerChip mention={{ ...mention, type: reference.type, id: reference.id }} />;
}
