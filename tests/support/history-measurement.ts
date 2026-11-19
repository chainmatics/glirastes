/**
 * Model-free measurement of what earlier tool results the model still gets
 * (`prepareModelMessages`): which ids and names of a list are in the model
 * input after N follow-up turns without tools, and the estimated input
 * tokens, for both `toolTurnCounting` modes, with and without the
 * seen-objects memo, for several `toolTurns` / `maxTokens` settings.
 * Deterministic, no network. The handler's message window is simulated as
 * the built-in handler applies it (`maxContextMessages` UI messages, the
 * rest passed as `earlierMessages` for the memo).
 */
import type { UIMessage } from 'ai';
import type { EntityDeclarationsByTool } from '../../src/contracts/entity-declaration.js';
import { prepareModelMessages, type HistoryOptions } from '../../src/server/adapters/nextjs/prepare-model-messages.js';

type Part = Record<string, unknown>;
type Id = string | number;

/** One list a tool answered, with the id and name of each entry to look for. */
export interface ListFixture {
  name: string;
  /** What the fixture stands for, for the docs. */
  shape: string;
  tool: string;
  result: unknown;
  entries: Array<{ idField: string; id: Id; name: string }>;
  /** The name field next to the id. */
  nameField: string;
  /** The declarations the app has; `{}` for an app without any. */
  entities: EntityDeclarationsByTool;
}

const uuid = (n: number, salt = 0) => `${String(salt).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pad = (n: number) => String(n).padStart(2, '0');

function pilotPlaylists(count: number, salt = 0): ListFixture {
  const data = Array.from({ length: count }, (_, index) => ({
    id: uuid(index + 1, salt),
    name: `Abendprogramm ${pad(index + 1)}-${salt}`,
    status: index % 2 === 0 ? 'published' : 'draft',
    durationSeconds: 1200 + index * 30,
    ownerId: uuid(900 + (index % 3), salt),
    updatedAt: '2026-10-01T08:00:00Z',
    description: 'Playlist für die Abendschiene mit Promos, Wetter und Musikblöcken. '.repeat(2),
  }));
  return {
    name: `pilot uuid list ${count}`,
    shape: `${count} entries, uuid \`id\`, \`name\`, 7 fields each (pilot-like)`,
    tool: 'playlists_list',
    result: { success: true, data },
    entries: data.map((entry) => ({ idField: 'id', id: entry.id, name: entry.name })),
    nameField: 'name',
    entities: { playlists_list: { output: [{ type: 'playlist', id: 'id', name: 'name', path: 'data[]' }] } },
  };
}

function vuePlaylists(): ListFixture {
  const playlists = Array.from({ length: 10 }, (_, index) => ({
    playlist_id: index + 1,
    displayName: `Lobby Loop ${pad(index + 1)}`,
    status: 'published',
    ownerKey: `owner-${index % 2}`,
    items: Array.from({ length: 3 }, (_, item) => ({
      item_id: (index + 1) * 100 + item,
      displayName: `Clip ${index + 1}.${item}`,
      durationSec: 30,
      fileUrl: `https://cdn.example/clip-${index + 1}-${item}.mp4?sig=abcdef`,
    })),
  }));
  return {
    name: 'vue-fastapi playlists',
    shape: '10 entries under `playlists[]`, numeric `playlist_id`, `displayName`, 3 nested items each',
    tool: 'playlists_list',
    result: { success: true, playlists, total: 10, offset: 0 },
    entries: playlists.map((entry) => ({ idField: 'playlist_id', id: entry.playlist_id, name: entry.displayName })),
    nameField: 'displayName',
    entities: { playlists_list: { output: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'playlists[]' }] } },
  };
}

function vueChannels(): ListFixture {
  const channels = Array.from({ length: 8 }, (_, index) => ({
    key: `CH-${pad(index + 1)}`,
    title: `Screen ${pad(index + 1)} Foyer`,
    playlist_id: index + 1,
    live: index % 2 === 0,
  }));
  return {
    name: 'vue-fastapi channels',
    shape: '8 entries under `channels[]`, speaking `key`, `title`',
    tool: 'channels_list',
    result: { success: true, channels },
    entries: channels.map((entry) => ({ idField: 'key', id: entry.key, name: entry.title })),
    nameField: 'title',
    entities: { channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', idKind: 'speaking', path: 'channels[]' }] } },
  };
}

export const FIXTURES: ReadonlyArray<ListFixture> = [
  pilotPlaylists(20),
  vuePlaylists(),
  vueChannels(),
  { ...pilotPlaylists(60, 1), name: 'long uuid list 60' },
  { ...pilotPlaylists(200, 3), name: 'long uuid list 200' },
  { ...pilotPlaylists(20, 2), name: 'pilot uuid list 20, undeclared', shape: 'as the pilot list, the app declares nothing', entities: {} },
];

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (id: string, parts: Part[]): UIMessage => ({ id, role: 'assistant', parts }) as UIMessage;

function listTurn(fixture: ListFixture, key: string): UIMessage[] {
  return [
    user(`u-${key}`, `Show me the ${fixture.name}`),
    assistant(`a-${key}`, [
      { type: 'step-start' },
      { type: `tool-${fixture.tool}`, toolCallId: `call-${key}`, state: 'output-available', input: {}, output: fixture.result },
      { type: 'step-start' },
      { type: 'text', text: `Here are the ${fixture.entries.length} entries: ${fixture.entries.slice(0, 5).map((entry) => entry.name).join(', ')} and more.` },
    ]),
  ];
}

function chatTurns(count: number, key: string): UIMessage[] {
  return Array.from({ length: count }, (_, index) => [
    user(`u-${key}-${index}`, index % 2 === 0 ? 'thanks, that helps' : 'ok, and what does that mean for tonight?'),
    assistant(`a-${key}-${index}`, [{ type: 'text', text: 'You are welcome. Tonight runs as planned; tell me what to change.' }]),
  ]).flat();
}

/** A scenario: the lists in the order they were shown, with turns without tools after each. */
export interface Scenario {
  name: string;
  lists: ListFixture[];
  messages: UIMessage[];
  followUps: number;
}

export function scenarios(followUps: ReadonlyArray<number> = [1, 3, 6]): Scenario[] {
  const single = FIXTURES.flatMap((fixture) => followUps.map((count): Scenario => ({
    name: fixture.name,
    lists: [fixture],
    followUps: count,
    messages: [...listTurn(fixture, 'l'), ...chatTurns(count, 'c'), user('u-now', 'Rename the third one')],
  })));
  const [first, second] = [vuePlaylists(), vueChannels()];
  const mixed = followUps.map((count): Scenario => ({
    name: 'two lists, chat in between',
    lists: [first, second],
    followUps: count,
    messages: [
      ...listTurn(first, 'l1'), ...chatTurns(1, 'c1'),
      ...listTurn(second, 'l2'), ...chatTurns(count, 'c2'),
      user('u-now', 'Put Lobby Loop 03 on Screen 02'),
    ],
  }));
  return [...single, ...mixed];
}

export interface Variant {
  label: string;
  toolTurnCounting: NonNullable<HistoryOptions['toolTurnCounting']>;
  seenObjects: boolean;
}

export const VARIANTS: ReadonlyArray<Variant> = [
  { label: 'all-turns', toolTurnCounting: 'all-turns', seenObjects: false },
  { label: 'tool-turns', toolTurnCounting: 'tool-turns', seenObjects: false },
  { label: 'all-turns + memo', toolTurnCounting: 'all-turns', seenObjects: true },
  { label: 'tool-turns + memo', toolTurnCounting: 'tool-turns', seenObjects: true },
];

export const TOOL_TURNS = [1, 2, 4] as const;
export const MAX_TOKENS = [4_000, 8_000, 16_000] as const;
export const MAX_CONTEXT_MESSAGES = [12, 60] as const;

export interface Measurement {
  scenario: string;
  followUps: number;
  variant: string;
  toolTurns: number;
  maxTokens: number;
  maxContextMessages: number;
  ids: number;
  names: number;
  /** Ids and names whose entry kept both. */
  pairs: number;
  total: number;
  estimatedTokens: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `"field":value` occurs in the serialized input, also inside a text part (escaped quotes). */
function hasField(serialized: string, field: string, value: Id): boolean {
  const encoded = JSON.stringify(value);
  const plain = `"${field}":${encoded}`;
  const escaped = JSON.stringify(plain).slice(1, -1);
  const tail = typeof value === 'number' ? '(?![0-9])' : '';
  return new RegExp(`(?:${escapeRegExp(plain)}|${escapeRegExp(escaped)})${tail}`).test(serialized);
}

function hasPair(serialized: string, entry: ListFixture['entries'][number], nameField: string): boolean {
  const pair = (text: string) => serialized.includes(text) || serialized.includes(JSON.stringify(text).slice(1, -1));
  const id = `"${entry.idField}":${JSON.stringify(entry.id)}`;
  return pair(`${id},"${nameField}":${JSON.stringify(entry.name)}`);
}

export async function measure(scenario: Scenario, variant: Variant, toolTurns: number, maxTokens: number, maxContextMessages: number): Promise<Measurement> {
  const entities = Object.assign({}, ...scenario.lists.map((list) => list.entities)) as EntityDeclarationsByTool;
  const window = scenario.messages.slice(-maxContextMessages);
  const earlierMessages = scenario.messages.slice(0, scenario.messages.length - window.length);
  const sent = await prepareModelMessages(window, {
    maxContextMessages,
    entities,
    ...(variant.seenObjects && earlierMessages.length > 0 ? { earlierMessages } : {}),
    history: { toolTurns, maxTokens, toolTurnCounting: variant.toolTurnCounting, seenObjects: variant.seenObjects },
  });
  const serialized = JSON.stringify(sent);
  let ids = 0;
  let names = 0;
  let pairs = 0;
  let total = 0;
  for (const list of scenario.lists) {
    const { nameField } = list;
    for (const entry of list.entries) {
      total += 1;
      if (hasField(serialized, entry.idField, entry.id)) ids += 1;
      if (serialized.includes(entry.name)) names += 1;
      if (hasPair(serialized, entry, nameField)) pairs += 1;
    }
  }
  return {
    scenario: scenario.name,
    followUps: scenario.followUps,
    variant: variant.label,
    toolTurns,
    maxTokens,
    maxContextMessages,
    ids,
    names,
    pairs,
    total,
    estimatedTokens: Math.ceil(serialized.length / 4),
  };
}

export async function measureAll(): Promise<Measurement[]> {
  const rows: Measurement[] = [];
  for (const scenario of scenarios()) {
    for (const maxContextMessages of MAX_CONTEXT_MESSAGES) {
      for (const variant of VARIANTS) {
        for (const toolTurns of TOOL_TURNS) {
          for (const maxTokens of MAX_TOKENS) {
            rows.push(await measure(scenario, variant, toolTurns, maxTokens, maxContextMessages));
          }
        }
      }
    }
  }
  return rows;
}

/** One cell: `ids kept/total ~tokens`. */
const cell = (row: Measurement) => `${row.pairs}/${row.total} ~${row.estimatedTokens}`;

/**
 * The full table as Markdown: one row per scenario, follow-ups, window,
 * variant and `toolTurns`; one column per `maxTokens`. A cell is the entries
 * whose id and name are both in the model input (next to each other), of all
 * entries listed, and the estimated input tokens of the history.
 */
export function renderTable(rows: ReadonlyArray<Measurement>): string {
  const lines = [
    `| List | Follow-ups | maxContextMessages | Mode | toolTurns | ${MAX_TOKENS.map((value) => `maxTokens ${value}`).join(' | ')} |`,
    `| --- | --- | --- | --- | --- | ${MAX_TOKENS.map(() => '---').join(' | ')} |`,
  ];
  const groups = new Map<string, Measurement[]>();
  for (const row of rows) {
    const key = [row.scenario, row.followUps, row.maxContextMessages, row.variant, row.toolTurns].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const [first] = group;
    lines.push(`| ${first!.scenario} | ${first!.followUps} | ${first!.maxContextMessages} | ${first!.variant} | ${first!.toolTurns} | ${group.map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** The settings of the summary table: the default, the two opt-ins alone, the pilot's settings. */
export const SUMMARY_COLUMNS: ReadonlyArray<{ label: string; match: Pick<Measurement, 'variant' | 'toolTurns' | 'maxTokens' | 'maxContextMessages'> }> = [
  { label: 'default (all-turns, toolTurns 1, 4000, window 12)', match: { variant: 'all-turns', toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 } },
  { label: 'tool-turns, toolTurns 1', match: { variant: 'tool-turns', toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 } },
  { label: 'all-turns + memo, toolTurns 1', match: { variant: 'all-turns + memo', toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 } },
  { label: 'tool-turns + memo, toolTurns 1', match: { variant: 'tool-turns + memo', toolTurns: 1, maxTokens: 4_000, maxContextMessages: 12 } },
  { label: 'pilot (all-turns, toolTurns 4, 16000, window 60)', match: { variant: 'all-turns', toolTurns: 4, maxTokens: 16_000, maxContextMessages: 60 } },
  { label: 'tool-turns, toolTurns 4, 16000, window 60', match: { variant: 'tool-turns', toolTurns: 4, maxTokens: 16_000, maxContextMessages: 60 } },
];

/** The compact table: one row per list and follow-ups, one column per {@link SUMMARY_COLUMNS} setting. */
export function renderSummary(rows: ReadonlyArray<Measurement>): string {
  const lines = [
    `| List | Follow-ups | ${SUMMARY_COLUMNS.map((column) => column.label).join(' | ')} |`,
    `| --- | --- | ${SUMMARY_COLUMNS.map(() => '---').join(' | ')} |`,
  ];
  const keys = [...new Set(rows.map((row) => `${row.scenario}|${row.followUps}`))];
  for (const key of keys) {
    const [scenario, followUps] = key.split('|');
    const cells = SUMMARY_COLUMNS.map(({ match }) => {
      const row = rows.find((candidate) => candidate.scenario === scenario && String(candidate.followUps) === followUps
        && candidate.variant === match.variant && candidate.toolTurns === match.toolTurns
        && candidate.maxTokens === match.maxTokens && candidate.maxContextMessages === match.maxContextMessages);
      return row ? cell(row) : '–';
    });
    lines.push(`| ${scenario} | ${followUps} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}
