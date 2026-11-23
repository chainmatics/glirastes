// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { getThemeVars } from '../../themes.js';
import type { ChatMessage, ChatTransport } from '../../types.js';
import {
  collectKnownEntities,
  entityNavigationHref,
  splitEntityText,
  type ChatEntityLinksConfig,
} from '../entity-links.js';

const TASK_KEY = /[A-Z][A-Z0-9]{0,5}-\d{1,9}/;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('splitEntityText', () => {
  it('finds matcher hits and known names as whole words, earliest and longest first', () => {
    const segments = splitEntityText('MAR-2 und MAR-23x gehören zu Marketing Team, nicht Marketing.', {
      matchers: [{ type: 'task', pattern: TASK_KEY }],
      known: [
        { type: 'team', id: 't1', label: 'Marketing Team' },
        { type: 'team', id: 't2', label: 'Marketing' },
        { type: 'team', id: 't3', label: 'Ops' },
      ],
    });
    expect(segments).toEqual([
      { kind: 'match', type: 'task', text: 'MAR-2', matcher: 0 },
      { kind: 'text', text: ' und MAR-23x gehören zu ' },
      { kind: 'entity', text: 'Marketing Team', reference: { type: 'team', id: 't1', label: 'Marketing Team' } },
      { kind: 'text', text: ', nicht ' },
      { kind: 'entity', text: 'Marketing', reference: { type: 'team', id: 't2', label: 'Marketing' } },
      { kind: 'text', text: '.' },
    ]);
  });

  it('joins a key and the known name right after it into one hit', () => {
    const known = [{ type: 'task', id: 'task-1', label: 'Check laightup und AI Act' }];
    const matchers = [{ type: 'task', pattern: TASK_KEY }];
    expect(splitEntityText('MAR-1 Check laightup und AI Act – offen', { matchers, known })).toEqual([
      { kind: 'match', type: 'task', text: 'MAR-1 Check laightup und AI Act', matcher: 0, match: 'MAR-1' },
      { kind: 'text', text: ' – offen' },
    ]);
    expect(splitEntityText('MAR-1: Check laightup und AI Act', { matchers, known })[0])
      .toMatchObject({ text: 'MAR-1: Check laightup und AI Act', match: 'MAR-1' });
    expect(splitEntityText('MAR-1 und Check laightup und AI Act', { matchers, known })).toHaveLength(3);
  });

  it('returns the text unchanged without matchers or known names', () => {
    expect(splitEntityText('Nichts zu sehen', {})).toEqual([{ kind: 'text', text: 'Nichts zu sehen' }]);
  });
});

describe('collectKnownEntities', () => {
  it('reads mention markers and the hits of an entity search tool', () => {
    const known = collectKnownEntities([
      { parts: [{ type: 'text', text: 'Schau {{mention:task:7:Release prüfen}} und {{mention:command:x:Cmd}}' }] },
      { parts: [{ type: 'tool-tasks_list', state: 'output-available', output: { tasks: [{ id: 8, title: 'Report schreiben' }, { id: '9' }] } }] },
      { parts: [{ type: 'tool-teams_list', state: 'output-available', output: { data: [{ id: 't1', name: 'Marketing' }] } }] },
    ], [
      { type: 'task', search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'], idField: 'id', labelField: 'title' } },
      { type: 'team', search: { tool: 'teams.list', path: '/api/teams', queryParam: 'search', itemsPath: [], idField: 'id', labelField: 'name' } },
    ]);
    expect(known).toEqual([
      { type: 'task', id: '7', label: 'Release prüfen' },
      { type: 'task', id: '8', label: 'Report schreiben' },
      { type: 'team', id: 't1', label: 'Marketing' },
    ]);
  });
});

describe('entityNavigationHref', () => {
  it('builds the page of an entity from its ui.navigate action', () => {
    const entity = defineChatEntity({
      type: 'task', label: 'Task', search: () => [],
      actions: [{ id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } }],
    });
    expect(entityNavigationHref(entity, 'a b')).toBe('/tasks/a%20b');
    expect(entityNavigationHref(defineChatEntity({ type: 'x', label: 'X', search: () => [] }), '1')).toBeUndefined();
  });
});

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const data: ChatInteractionsData = {
  schemaVersion: 1,
  commands: [],
  entities: [{
    type: 'task',
    label: 'Task',
    search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'], idField: 'id', labelField: 'title' },
    actions: [{ id: 'task.open', label: 'Open', entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } }],
  }],
};

function Chat({ messages, entityLinks, bus }: { messages: ChatMessage[]; entityLinks?: ChatEntityLinksConfig; bus: UiActionBus }) {
  const interactions = useMemo(() => ({ data, fetch: vi.fn() as unknown as typeof fetch }), []);
  return (
    <AiChatProvider transport={transport(messages)} chatInteractions={interactions} entityLinks={entityLinks} uiActionBus={bus}>
      <AiChatPanel />
    </AiChatProvider>
  );
}

describe('entity chips in answers', () => {
  const answer = (text: string): ChatMessage => ({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] });

  it('turns task keys into chips that open through the app handler', async () => {
    const open = vi.fn();
    const resolve = vi.fn((key: string) => (key === 'MAR-2' ? { id: 'task-2', label: 'Release prüfen' } : undefined));
    const links: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK_KEY, resolve }], open };
    render(<Chat messages={[answer('Erledigt: **MAR-2** ist zu, MAR-404 gibt es nicht.')]} entityLinks={links} bus={new UiActionBus()} />);
    // Wait with a plain selector, then check the role once. A *ByRole query computes styles for every
    // element of the panel; polled on each DOM change it held the event loop so long under load that
    // the key resolution it waited for missed the 1 s budget.
    await waitFor(() => expect(document.querySelector('button[aria-label="Open Release prüfen"]')).not.toBeNull());
    const chip = screen.getByRole('button', { name: 'Open Release prüfen' });
    expect(chip.textContent).toBe('MAR-2');
    expect(chip.closest('[data-component="mention-chip"]')?.getAttribute('data-mention-type')).toBe('task');
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('MAR-404'));
    expect(screen.queryByRole('button', { name: /MAR-404/ })).toBeNull();
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith({ type: 'task', id: 'task-2', label: 'Release prüfen' });
  });

  it('renders a key with the known name after it as one chip and resolves the key alone', async () => {
    const resolve = vi.fn(() => ({ id: 'task-2', label: 'Release prüfen' }));
    const links: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK_KEY, resolve }], open: vi.fn() };
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Was ist mit {{mention:task:task-2:Release prüfen}}?' }] },
      answer('MAR-2 Release prüfen ist offen.'),
    ];
    render(<Chat messages={messages} entityLinks={links} bus={new UiActionBus()} />);
    await waitFor(() => {
      const chips = screen.getAllByRole('button', { name: 'Open Release prüfen' }).map((chip) => chip.textContent);
      expect(chips.filter((text) => text?.includes('MAR-2'))).toEqual(['MAR-2 Release prüfen']);
      expect(chips).toHaveLength(2);
    });
    expect(resolve).toHaveBeenCalledWith('MAR-2');
  });

  it('links names the conversation already referenced and navigates through the bus by default', async () => {
    const bus = new UiActionBus();
    const navigate = vi.fn();
    bus.subscribeById('glirastes.navigate', navigate);
    render(<Chat
      bus={bus}
      entityLinks={{}}
      messages={[
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Was ist mit {{mention:task:7:Release prüfen}}?' }] },
        answer('Release prüfen ist offen.'),
      ]}
    />);
    const chips = await screen.findAllByRole('button', { name: 'Open Release prüfen' });
    // The user's mention and the name in the answer.
    expect(chips).toHaveLength(2);
    await act(async () => { fireEvent.click(chips[1]!); });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ payload: { href: '/tasks/7' } }));
  });

  it('leaves answers as text without entityLinks, but keeps mention chips openable', async () => {
    render(<Chat
      bus={new UiActionBus()}
      messages={[
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Was ist mit {{mention:task:7:Release prüfen}}?' }] },
        answer('Release prüfen ist offen.'),
      ]}
    />);
    expect(await screen.findAllByRole('button', { name: 'Open Release prüfen' })).toHaveLength(1);
  });
});

describe('pill theme colors', () => {
  it('emits pill variables only when a theme sets them', () => {
    expect(getThemeVars()).not.toHaveProperty('--cm-pill-command-bg');
    expect(getThemeVars({ colors: { pillCommand: '#ede9fe', pillEntityText: '#115e59' } })).toMatchObject({
      '--cm-pill-command-bg': '#ede9fe',
      '--cm-pill-entity-text': '#115e59',
    });
  });
});
