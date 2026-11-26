// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect, useReducer, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every prop of `AiChatProvider` against the finished messages of `MessageList`, probed (not read from the
 * code), one row per prop:
 * - `inline`: the component holding the provider renders on every chunk and passes a NEW value each time
 *   (`all`: every finished message renders per chunk, as on main; `none`: none renders);
 * - `read`: another value (a new object or primitive) renders the finished messages (`yes`) or not (`no`);
 * - `inPlace`: a change made in place and passed as the SAME object again, then the same content as a new
 *   object; what a finished message shows at [before, same object again, new object]. `MAIN_IN_PLACE` holds
 *   what main shows; head equals it except where the row says `delayed` (step two only).
 * Counted: a bubble render (the default bubble's part reader) or a react-markdown parse of a finished message.
 */
const renders = new Map<string, number>();
const owners = new WeakMap<object, string>();
let live: { messages: ReadonlyArray<{ id: string; parts: unknown }> } | null = null;
const bump = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
vi.mock('../../contracts/step-failure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contracts/step-failure.js')>();
  return {
    ...actual,
    readStepFailurePartCodes: (...args: Parameters<typeof actual.readStepFailurePartCodes>) => {
      if (/message-bubble\.tsx/.test((new Error().stack ?? '').split('\n').slice(2, 4).join())) {
        const id = owners.get(args[0] as object) ?? live?.messages.find((message) => message.parts === args[0])?.id;
        if (id) bump(id);
      }
      return actual.readStepFailurePartCodes(...args);
    },
  };
});
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return {
    ...actual,
    default: (options: Parameters<typeof actual.default>[0]) => {
      const id = /ref-(\w+)/.exec(String(options.children ?? ''))?.[1];
      if (id) bump(id);
      return actual.default(options);
    },
  };
});

import { UiActionBus } from '../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { AiChatProvider, type AiChatProviderProps } from '../provider/ai-chat-provider.js';
import type { AiChatProviderConfig, ChatMessage, MentionChipProps } from '../types.js';
import { StreamingChat } from './streaming-chat.js';
import { bindChatComponent } from '../chat-views/registry.js';
import { starterChatComponents } from '../../chat-views/starter-catalog.js';

const TURNS = 4;
const DECLARED: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
};
function conversation(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    messages.push({ id: `q${turn}`, role: 'user', parts: [{ type: 'text', text: `ref-q${turn} is {{mention:channel:c${turn}_0:Channel ${turn} zero}} live?` }] });
    messages.push({
      id: `r${turn}`, role: 'assistant', parts: [
        {
          type: 'tool-channels_list', toolCallId: `t${turn}`, state: 'output-available', input: {},
          output: { channels: Array.from({ length: 6 }, (_, record) => ({ key: `c${turn}_${record}`, title: `Channel ${turn} n${record}` })) },
        },
        {
          type: 'tool-channel_archive', toolCallId: `w${turn}`, state: 'output-available', input: { channel_id: `c${turn}_4` },
          approval: { id: `ap${turn}`, approved: true }, output: { message: 'archived' },
        },
        { type: 'text', text: `**ref-r${turn}**: {{mention:channel:c${turn}_1:Channel ${turn} n1}} and Channel ${turn} n2 run.\n\n- MAR-${turn}` },
        ...(turn === 0
          ? [{
            type: 'tool-ask_clarification', toolCallId: 'k0', state: 'output-available',
            input: { question: 'Which one?', options: [{ id: 'a', label: 'Alpha' }] }, output: {},
          }]
          : []),
      ],
    } as unknown as ChatMessage);
  }
  return messages;
}
const finishedIds = Array.from({ length: TURNS }, (_, turn) => [`q${turn}`, `r${turn}`]).flat();

const bus = new UiActionBus();
const matchers = [{ type: 'task', pattern: /MAR-\d+/, resolve: (key: string) => ({ id: key, label: key }) }];
const open = () => {};
/** The config every row starts from, kept stable (module constants). */
const BASE: Partial<AiChatProviderConfig> = {
  entityLinks: { mentionMarkers: 'markdown', matchers, open },
  entityDeclarations: DECLARED,
  uiActionBus: bus,
  messageFooter: true,
  approvalDisplay: { decided: 'entry', open: 'inline' },
};

let chat: StreamingChat;
function Host({ config, fresh }: { config: () => Partial<AiChatProviderConfig>; fresh?: boolean }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), []);
  // `fresh`: the props are built on every render (an inline object); else the ones of the first render.
  const props = fresh ? config() : (Host.kept ??= config());
  return (
    <AiChatProvider transport={chat.transport} {...BASE} {...props}>
      <AiChatPanel />
    </AiChatProvider>
  );
}
Host.kept = undefined as Partial<AiChatProviderConfig> | undefined;

async function settle() {
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}
async function mount(node: ReactNode) {
  chat = new StreamingChat();
  chat.messages = conversation();
  live = chat;
  for (const message of chat.messages) owners.set(message.parts as object, message.id);
  const view = render(node);
  await waitFor(() => expect(document.querySelectorAll('[data-component="markdown"]').length).toBeGreaterThan(0), { timeout: 5000 });
  await waitFor(() => expect(document.querySelector('[data-element="markdown-skeleton"]')).toBeNull(), { timeout: 5000 });
  await settle();
  return view;
}
async function chunks(count: number) {
  for (let chunk = 1; chunk <= count; chunk += 1) {
    await act(async () => { chat.stream([{ type: 'text', text: `streaming ${'x'.repeat(chunk)}` }]); });
  }
}
/** `all` when every finished message rendered on every chunk, `none` when none did, else `some`. */
function perChunk(count: number): 'all' | 'none' | 'some' {
  const counted = finishedIds.map((id) => renders.get(id) ?? 0);
  if (counted.every((n) => n === 0)) return 'none';
  return counted.every((n) => n >= count) ? 'all' : 'some';
}

const R1 = () => <span data-renderer-mark="one">one</span>;
const R2 = () => <span data-renderer-mark="two">two</span>;
const GROUP_BINDING = bindChatComponent(starterChatComponents[0]!, R1);
const SCHEMA = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
function ChipB({ mention }: MentionChipProps) {
  return <span data-chip-b={mention.id}>{mention.displayName}</span>;
}
const plugin = () => (tree: { children: unknown[] }) => {
  tree.children.push({ type: 'paragraph', children: [{ type: 'text', value: 'PLUGGED' }] });
};
const noop = () => {};
const LINKS_WITHOUT_OPEN = { mentionMarkers: 'markdown' as const, matchers };
const NAVIGATE = { id: 'open', label: 'Open', entityArg: 'id', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/channels/:id' } } };
const r0 = () => document.querySelectorAll('[data-component="message-bubble"]')[1]!;

interface InPlace {
  /** Changes the config object in place. */
  change: (config: Record<string, unknown>) => void;
  /** The same content as a new object (top level). */
  copy: (config: Record<string, unknown>) => Record<string, unknown>;
  /** What the finished answer r0 shows. */
  shows: () => string;
}
interface Row {
  prop: keyof AiChatProviderProps;
  /** A value, a new object on every call. */
  sample: () => Record<string, unknown>;
  /** Another value. */
  other?: () => Record<string, unknown>;
  inPlace?: InPlace;
  expected: { inline: 'all' | 'some' | 'none'; read: 'yes' | 'no'; inPlace?: 'as main' | 'delayed' };
}

const ROWS: Row[] = [
  // Read by messages, a new object renders every message.
  {
    prop: 'classNames', sample: () => ({ classNames: { messageBubble: 'before' } }), other: () => ({ classNames: { messageBubble: 'other' } }),
    inPlace: { change: (c) => { (c.classNames as Record<string, string>).messageBubble = 'after'; }, copy: (c) => ({ classNames: { ...(c.classNames as object) } }), shows: () => r0().className },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'components', sample: () => ({ components: { TurnNotice: () => null } }), other: () => ({ components: { MentionChip: ChipB } }),
    inPlace: { change: (c) => { (c.components as Record<string, unknown>).MentionChip = ChipB; }, copy: (c) => ({ components: { ...(c.components as object) } }), shows: () => String(r0().querySelectorAll('[data-chip-b]').length) },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'toolLabels', sample: () => ({ toolLabels: { labels: { channels_list: { singular: 'before', plural: 'before' } } } }),
    other: () => ({ toolLabels: { labels: { channels_list: { singular: 'other', plural: 'other' } } } }),
    inPlace: {
      change: (c) => { Object.assign((c.toolLabels as { labels: Record<string, object> }).labels.channels_list!, { singular: 'after', plural: 'after' }); },
      copy: (c) => ({ toolLabels: { ...(c.toolLabels as object) } }),
      shows: () => r0().querySelector('[data-element="activity-step"] [data-element="label"]')?.textContent ?? '',
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'toolResults', sample: () => ({ toolResults: { mode: 'allowlist', allowlist: ['channels_list', 'channel_archive'] } }),
    other: () => ({ toolResults: { mode: 'hidden' } }),
    inPlace: {
      change: (c) => { (c.toolResults as { allowlist: string[] }).allowlist.splice(0, 1); },
      copy: (c) => ({ toolResults: { ...(c.toolResults as object) } }),
      shows: () => String(r0().querySelectorAll('[data-component="tool-result"]').length),
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'entityDeclarations', sample: () => ({ entityDeclarations: { channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] } } }),
    other: () => ({ entityDeclarations: { channels_list: { output: [{ type: 'room', id: 'key', name: 'title', path: 'channels[]' }] } } }),
    inPlace: {
      change: (c) => { (c.entityDeclarations as { channels_list: { output: Array<{ name: string }> } }).channels_list.output[0]!.name = 'key'; },
      copy: (c) => ({ entityDeclarations: { ...(c.entityDeclarations as object) } }),
      // The approval entry names the archived record by the declared name field; the known name "Channel 0 n2"
      // in the answer is a chip while the declaration names records by `title`.
      shows: () => `${(r0().querySelector('[data-component="approval-entry"]')?.textContent ?? '').includes('Channel 0 n4') ? 'title' : 'key'}/${[...r0().querySelectorAll('[data-component="mention-chip"]')].filter((chip) => chip.textContent?.includes('n2')).length}`,
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'composer', sample: () => ({ composer: { hint: false } }), other: () => ({ composer: { clarificationChips: true } }),
    inPlace: {
      change: (c) => { (c.composer as Record<string, unknown>).clarificationChips = true; },
      copy: (c) => ({ composer: { ...(c.composer as object) } }),
      shows: () => String(r0().querySelectorAll('[data-component="clarification-card"] [data-action="answer-option"]').length),
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    // Inline: every Markdown text parses again per chunk (the bubbles do not render; questions with chips have none).
    prop: 'markdown', sample: () => ({ markdown: { remarkPlugins: [] } }), other: () => ({ markdown: { remarkPlugins: [plugin] } }),
    inPlace: {
      change: (c) => { ((c.markdown as { remarkPlugins: unknown[] }).remarkPlugins).push(plugin); },
      copy: (c) => ({ markdown: { ...(c.markdown as object) } }),
      shows: () => String(r0().textContent?.includes('PLUGGED')),
    },
    expected: { inline: 'some', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'toolRenderers', sample: () => ({ toolRenderers: [{ definitionId: 'channels_list', schemaVersion: 1, outputSchema: SCHEMA, component: R1 }] }),
    other: () => ({ toolRenderers: [{ definitionId: 'channels_list', schemaVersion: 1, outputSchema: SCHEMA, component: R2 }] }),
    inPlace: {
      change: (c) => { (c.toolRenderers as Array<{ component: unknown }>)[0]!.component = R2; },
      copy: (c) => ({ toolRenderers: [...(c.toolRenderers as object[])] }),
      shows: () => r0().querySelector('[data-renderer-mark]')?.getAttribute('data-renderer-mark') ?? '',
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    prop: 'locale', sample: () => ({ locale: { copyMessageLabel: 'before' } }), other: () => ({ locale: { copyMessageLabel: 'other' } }),
    inPlace: { change: (c) => { (c.locale as Record<string, string>).copyMessageLabel = 'after'; }, copy: (c) => ({ locale: { ...(c.locale as object) } }), shows: () => r0().querySelector('[data-action="copy"]')?.textContent ?? '' },
    expected: { inline: 'all', read: 'yes', inPlace: 'as main' },
  },
  {
    prop: 'locales', sample: () => ({ language: 'en', locales: { en: { copyMessageLabel: 'before' } } }),
    other: () => ({ language: 'en', locales: { en: { copyMessageLabel: 'other' } } }),
    inPlace: {
      change: (c) => { (c.locales as Record<string, Record<string, string>>).en!.copyMessageLabel = 'after'; },
      copy: (c) => ({ language: 'en', locales: { ...(c.locales as object) } }),
      shows: () => r0().querySelector('[data-action="copy"]')?.textContent ?? '',
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'as main' },
  },
  {
    prop: 'triggers', sample: () => ({ triggers: [{ char: '#', prefix: '#', types: ['channel'] }] }), other: () => ({ triggers: [{ char: '#', prefix: '~', types: ['channel'] }] }),
    inPlace: {
      change: (c) => { (c.triggers as Array<{ prefix: string }>)[0]!.prefix = '~'; },
      copy: (c) => ({ triggers: [...(c.triggers as object[])] }),
      shows: () => r0().querySelector('[data-mention-type="channel"] [data-element="prefix"]')?.textContent ?? '',
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'as main' },
  },
  {
    prop: 'entityLinks', sample: () => ({ entityLinks: { mentionMarkers: 'markdown', matchers, open } }),
    other: () => ({ entityLinks: { mentionMarkers: 'markdown', matchers, open, minLabelLength: 100 } }),
    inPlace: {
      change: (c) => { (c.entityLinks as Record<string, unknown>).minLabelLength = 100; },
      copy: (c) => ({ entityLinks: { ...(c.entityLinks as object) } }),
      shows: () => String(r0().querySelectorAll('[data-component="mention-chip"]').length),
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'as main' },
  },
  {
    // Without `entityLinks.open` a chip opens through an entity's navigate action of `chatInteractions`.
    prop: 'chatInteractions', sample: () => ({ entityLinks: LINKS_WITHOUT_OPEN, chatInteractions: { entities: [{ type: 'channel', label: 'Channel', search: () => [], actions: [] as unknown[] }] } }),
    other: () => ({ entityLinks: LINKS_WITHOUT_OPEN, chatInteractions: { entities: [{ type: 'channel', label: 'Channel', search: () => [], actions: [NAVIGATE] }] } }),
    inPlace: {
      change: (c) => { (c.chatInteractions as { entities: Array<{ actions: unknown[] }> }).entities[0]!.actions.push(NAVIGATE); },
      copy: (c) => ({ entityLinks: LINKS_WITHOUT_OPEN, chatInteractions: { ...(c.chatInteractions as object) } }),
      shows: () => String(r0().querySelectorAll('[data-mention-type="channel"] [data-action="open"]').length),
    },
    expected: { inline: 'all', read: 'yes', inPlace: 'delayed' },
  },
  {
    // Probed: not read by messages (the composer's lists; the mention prefix of chips comes from `triggers`).
    prop: 'completionProviders', sample: () => ({ completionProviders: [{ id: 'p', trigger: '#', search: () => [] }] }),
    other: () => ({ completionProviders: [{ id: 'q', trigger: '+', search: () => [] }] }),
    expected: { inline: 'none', read: 'no' },
  },
  { prop: 'approvalDescription', sample: () => ({ approvalDescription: (toolName: string, id: string) => ({ id, toolName, args: {}, messageId: '', description: 'mine' }) }), expected: { inline: 'all', read: 'yes' } },
  { prop: 'language', sample: () => ({ language: 'en' }), other: () => ({ language: 'de' }), expected: { inline: 'none', read: 'yes' } },
  // Reaches messages only through `language`, once the server states one (none here).
  { prop: 'languageSource', sample: () => ({ languageSource: 'page' }), other: () => ({ languageSource: 'server' }), expected: { inline: 'none', read: 'no' } },
  { prop: 'approvalSubjects', sample: () => ({ approvalSubjects: true }), other: () => ({ approvalSubjects: false }), expected: { inline: 'none', read: 'yes' } },
  // Keyed on their fields by the provider: inline is no change, an in-place change applies at the next render.
  {
    prop: 'activityLog', sample: () => ({ activityLog: { details: 'none' } }), other: () => ({ activityLog: { details: 'all' } }),
    inPlace: { change: (c) => { (c.activityLog as Record<string, string>).details = 'all'; }, copy: (c) => ({ activityLog: { ...(c.activityLog as object) } }), shows: () => String(r0().querySelectorAll('[data-element="detail"]').length) },
    expected: { inline: 'none', read: 'yes', inPlace: 'as main' },
  },
  {
    prop: 'messageFooter', sample: () => ({ messageFooter: { copy: true } }), other: () => ({ messageFooter: { copy: false } }),
    inPlace: { change: (c) => { (c.messageFooter as Record<string, boolean>).copy = false; }, copy: (c) => ({ messageFooter: { ...(c.messageFooter as object) } }), shows: () => String(r0().querySelectorAll('[data-action="copy"]').length) },
    expected: { inline: 'none', read: 'yes', inPlace: 'as main' },
  },
  {
    prop: 'approvalDisplay', sample: () => ({ approvalDisplay: { decided: 'entry', open: 'inline' } }), other: () => ({ approvalDisplay: { decided: 'none', open: 'inline' } }),
    inPlace: { change: (c) => { (c.approvalDisplay as Record<string, string>).decided = 'none'; }, copy: (c) => ({ approvalDisplay: { ...(c.approvalDisplay as object) } }), shows: () => String(r0().querySelectorAll('[data-component="approval-entry"]').length) },
    expected: { inline: 'none', read: 'yes', inPlace: 'as main' },
  },
  {
    // In place: nothing a finished message shows depends on it (the follow-ups are the latest answer's).
    prop: 'suggestions', sample: () => ({ suggestions: { placement: 'composer' } }), other: () => ({ suggestions: { placement: 'message', count: 2 } }),
    expected: { inline: 'none', read: 'yes' },
  },
  {
    // Keyed on its fields: an inline object with the same (memoized) components array is no change.
    prop: 'chatViews', sample: () => ({ chatViews: {} }), other: () => ({ chatViews: { components: [GROUP_BINDING] } }),
    expected: { inline: 'none', read: 'yes' },
  },
  // Not read by messages: neither a new value nor building it inline renders a finished message.
  { prop: 'transport', sample: () => ({}), expected: { inline: 'none', read: 'no' } },
  { prop: 'mentions', sample: () => ({ mentions: { search: async () => [], resolve: async (id: string, type: string) => ({ id, type, label: id }), types: ['task'] } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'completionContext', sample: () => ({ completionContext: { roles: ['admin'] } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onCompletionProviderError', sample: () => ({ onCompletionProviderError: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onCompletionSelect', sample: () => ({ onCompletionSelect: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'mentionContext', sample: () => ({ mentionContext: { preferredTypes: ['channel'] } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onOpenRequest', sample: () => ({ onOpenRequest: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'attachments', sample: () => ({ attachments: { maxFiles: 3 } }), other: () => ({ attachments: false }), expected: { inline: 'none', read: 'no' } },
  { prop: 'voice', sample: () => ({ voice: { enabled: false } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'session', sample: () => ({ session: { save: () => {} } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'sendLanguage', sample: () => ({ sendLanguage: true }), other: () => ({ sendLanguage: false }), expected: { inline: 'none', read: 'no' } },
  { prop: 'theme', sample: () => ({ theme: { colors: { primary: '#111111' } } }), other: () => ({ theme: { colors: { primary: '#222222' } } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'themeScope', sample: () => ({ themeScope: 'inline' }), other: () => ({ themeScope: 'inherit' }), expected: { inline: 'none', read: 'no' } },
  { prop: 'unstyled', sample: () => ({ unstyled: false }), other: () => ({ unstyled: true }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onToolResult', sample: () => ({ onToolResult: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'uiActionBus', sample: () => ({ uiActionBus: new UiActionBus() }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onUiActionOutcome', sample: () => ({ onUiActionOutcome: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onTurnEnd', sample: () => ({ onTurnEnd: () => {} }), expected: { inline: 'none', read: 'no' } },
  { prop: 'uiActionOutcomeTimeoutMs', sample: () => ({ uiActionOutcomeTimeoutMs: 1000 }), other: () => ({ uiActionOutcomeTimeoutMs: 2000 }), expected: { inline: 'none', read: 'no' } },
  { prop: 'uiActionOutcomes', sample: () => ({ uiActionOutcomes: true }), other: () => ({ uiActionOutcomes: false }), expected: { inline: 'none', read: 'no' } },
  { prop: 'onBeforeSend', sample: () => ({ onBeforeSend: (text: string) => text }), expected: { inline: 'none', read: 'no' } },
  { prop: 'continueMessage', sample: () => ({ continueMessage: 'Please continue.' }), other: () => ({ continueMessage: 'Weiter.' }), expected: { inline: 'none', read: 'no' } },
  { prop: 'queue', sample: () => ({ queue: { enabled: false } }), other: () => ({ queue: { enabled: true } }), expected: { inline: 'none', read: 'no' } },
  { prop: 'pipelineMessageTranslator', sample: () => ({ pipelineMessageTranslator: (message: string) => message }), expected: { inline: 'none', read: 'no' } },
  { prop: 'stepSummaryFormatter', sample: () => ({ stepSummaryFormatter: () => '' }), expected: { inline: 'none', read: 'no' } },
];

/**
 * The groups of the CHANGELOG, one per prop:
 * A as main: an in-place change shows like on main, and building it inline does not render every message.
 * B delayed in place: an in-place change passed as the same object shows in a finished message only once it
 *   renders for another reason or a new object arrives (building it inline also renders every message).
 * C inline renders every message per chunk (as main); in place as main, or a function.
 * D not read by messages.
 */
const GROUPS: Record<'A' | 'B' | 'C' | 'D', ReadonlyArray<keyof AiChatProviderProps>> = {
  A: ['language', 'approvalSubjects', 'activityLog', 'messageFooter', 'approvalDisplay', 'suggestions', 'chatViews'],
  B: ['classNames', 'components', 'toolLabels', 'toolResults', 'entityDeclarations', 'composer', 'markdown', 'toolRenderers', 'chatInteractions'],
  C: ['locale', 'locales', 'triggers', 'entityLinks', 'approvalDescription'],
  D: [
    'transport', 'mentions', 'completionProviders', 'completionContext', 'onCompletionProviderError', 'onCompletionSelect', 'mentionContext',
    'onOpenRequest', 'attachments', 'voice', 'session', 'languageSource', 'sendLanguage', 'theme', 'themeScope', 'unstyled', 'onToolResult',
    'uiActionBus', 'onUiActionOutcome', 'onTurnEnd', 'uiActionOutcomeTimeoutMs', 'uiActionOutcomes', 'onBeforeSend', 'continueMessage',
    'queue', 'pipelineMessageTranslator', 'stepSummaryFormatter',
  ],
};
it('puts every prop into exactly one group, matching its probed behaviour', () => {
  const all = Object.values(GROUPS).flat();
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort()).toEqual(ROWS.map((row) => row.prop).sort());
  for (const row of ROWS) {
    const group = (Object.keys(GROUPS) as Array<keyof typeof GROUPS>).find((key) => GROUPS[key].includes(row.prop))!;
    const { inline, read, inPlace } = row.expected;
    const fits = {
      A: inline === 'none' && read === 'yes' && inPlace !== 'delayed',
      B: inPlace === 'delayed' && inline !== 'none',
      C: inline !== 'none' && inPlace !== 'delayed',
      D: inline === 'none' && read === 'no',
    }[group];
    expect(fits, `${row.prop} in ${group}`).toBe(true);
  }
});

/** Every prop has a row: adding a prop to `AiChatProviderProps` without one fails the type check of the tests. */
const COVERED: Record<Exclude<keyof AiChatProviderProps, 'children'>, true> = {
  classNames: true,
  components: true,
  toolLabels: true,
  toolResults: true,
  entityDeclarations: true,
  composer: true,
  markdown: true,
  toolRenderers: true,
  locale: true,
  locales: true,
  triggers: true,
  entityLinks: true,
  chatInteractions: true,
  completionProviders: true,
  approvalDescription: true,
  language: true,
  languageSource: true,
  approvalSubjects: true,
  activityLog: true,
  messageFooter: true,
  approvalDisplay: true,
  suggestions: true,
  chatViews: true,
  transport: true,
  mentions: true,
  completionContext: true,
  onCompletionProviderError: true,
  onCompletionSelect: true,
  mentionContext: true,
  onOpenRequest: true,
  attachments: true,
  voice: true,
  session: true,
  sendLanguage: true,
  theme: true,
  themeScope: true,
  unstyled: true,
  onToolResult: true,
  uiActionBus: true,
  onUiActionOutcome: true,
  onTurnEnd: true,
  uiActionOutcomeTimeoutMs: true,
  uiActionOutcomes: true,
  onBeforeSend: true,
  continueMessage: true,
  queue: true,
  pipelineMessageTranslator: true,
  stepSummaryFormatter: true,
};
it('has one row per prop of AiChatProviderProps (children aside)', () => {
  expect(new Set(ROWS.map((row) => row.prop)).size).toBe(ROWS.length);
  expect(Object.keys(COVERED).sort()).toEqual(ROWS.map((row) => row.prop).sort());
});

/** What main (8425a25b) shows at [before, same object again, new object], recorded with `RECORD`. */
const MAIN_IN_PLACE: Record<string, [string, string, string]> = {
  classNames: ["before", "after", "after"],
  components: ["0", "3", "3"],
  toolLabels: ["before", "after", "after"],
  toolResults: ["2", "1", "1"],
  entityDeclarations: ["title/1", "key/1", "key/0"],
  composer: ["1", "0", "0"],
  markdown: ["false", "true", "true"],
  toolRenderers: ["one", "two", "two"],
  locale: ["before", "before", "after"],
  locales: ["before", "before", "after"],
  triggers: ["#", "#", "~"],
  entityLinks: ["3", "2", "2"],
  chatInteractions: ["0", "2", "2"],
  activityLog: ["0", "1", "1"],
  messageFooter: ["1", "0", "0"],
  approvalDisplay: ["1", "0", "0"],
};

beforeEach(() => {
  renders.clear();
  Host.kept = undefined;
});
afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const record = (line: unknown) => { if (process.env.RECORD) require('fs').appendFileSync(process.env.RECORD, `${JSON.stringify(line)}\n`); };

describe('every AiChatProvider prop against finished messages', () => {
  it.each(ROWS.map((row) => [row.prop, row] as const))('%s: built inline on every render', async (prop, row) => {
    await mount(<Host config={row.sample} fresh />);
    await act(async () => { void chat.sendMessage({ text: 'ref-question go' }); });
    await chunks(1);
    renders.clear();
    await chunks(3);
    const seen = perChunk(3);
    record(['inline', prop, seen]);
    if (!process.env.RECORD) expect(seen).toBe(row.expected.inline);
  });

  it.each(ROWS.filter((row) => row.other).map((row) => [row.prop, row] as const))('%s: another value', async (prop, row) => {
    const view = await mount(<Host config={row.sample} />);
    renders.clear();
    Host.kept = row.other!();
    view.rerender(<Host config={row.sample} />);
    await settle();
    const seen = finishedIds.some((id) => (renders.get(id) ?? 0) > 0) ? 'yes' : 'no';
    record(['read', prop, seen]);
    if (!process.env.RECORD) expect(seen).toBe(row.expected.read);
  });

  it.each(ROWS.filter((row) => row.inPlace).map((row) => [row.prop, row] as const))('%s: changed in place', async (prop, row) => {
    const config = row.sample();
    const view = await mount(<Host config={() => config} />);
    const seen = [row.inPlace!.shows()];
    row.inPlace!.change(config);
    // The same object again: the provider renders (as on every chunk).
    view.rerender(<Host config={() => config} />);
    await settle();
    seen.push(row.inPlace!.shows());
    Host.kept = row.inPlace!.copy(config);
    view.rerender(<Host config={() => config} />);
    await settle();
    seen.push(row.inPlace!.shows());
    record(['inPlace', prop, seen]);
    if (process.env.RECORD) return;
    const main = MAIN_IN_PLACE[prop]!;
    // The value changes in place (otherwise the row proves nothing), and a new object always shows it as main does.
    expect(main[1] !== main[0] || main[2] !== main[0]).toBe(true);
    expect([seen[0], seen[2]]).toEqual([main[0], main[2]]);
    if (row.expected.inPlace === 'as main') expect(seen[1]).toBe(main[1]);
    else {
      // Delayed: main shows the change at the provider's next render, the finished message here only later.
      expect(main[1]).not.toBe(main[0]);
      expect(seen[1]).toBe(seen[0]);
    }
  });
});

export { noop };
