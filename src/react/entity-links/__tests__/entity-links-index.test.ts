import { describe, expect, it } from 'vitest';
import type { ChatEntitySearchData } from '../../../contracts/chat-interactions.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import {
  collectKnownEntities,
  collectSeenReferenceKeys,
  createConversationEntityIndex,
  createEntityTextSplitter,
  createRegexCache,
  sameReferences,
  splitEntityText,
  type ChatEntityReference,
} from '../entity-links.js';
import * as released from './entity-links-0.29.0.js';

/**
 * Differential test: the per-message index and the prepared splitter against
 * the functions as released in 0.29.0, on generated conversations that change
 * the way a chat does (streamed chunks, tool results arriving, edits, removals,
 * a regenerate, a session switch, parts changed in place).
 */

type Part = Record<string, unknown>;
type Message = { id: string; role: 'user' | 'assistant'; parts: Part[] };
type Searches = ReadonlyArray<{ readonly type: string; readonly search: ChatEntitySearchData }>;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const DECLARATIONS: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
  slots_list: { output: [{ type: 'slot', id: ['screen', 'slot'], name: 'label', path: 'slots[]' }] },
  rows_list: { output: [{ id: 'id', path: 'rows[]' }] },
  report: { output: [{ type: 'task', id: 'id', name: 'title' }] },
};
const OTHER_DECLARATIONS: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'Channel', id: 'key', name: 'title', path: 'channels[]' }] },
};
const SEARCHES: Searches = [{
  type: 'task',
  search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'], idField: 'id', labelField: 'title' },
}];

/** Few names and ids, so names repeat across types and records (the ambiguous cases). */
const NAMES = ['Lobby Loop', 'Lobby', 'Main Hall', 'Release prüfen', 'Flyer drucken', 'Q3 Plan', 'Lobby Loop 2'];
const TYPES = ['channel', 'task', 'Channel', 'slot', 'command'];

function generator(seed: number) {
  const next = random(seed);
  const pick = <T,>(list: ReadonlyArray<T>): T => list[Math.floor(next() * list.length)]!;
  const id = () => `${Math.floor(next() * 6)}`;
  let counter = 0;
  const marker = () => `{{mention:${pick(TYPES)}:${id()}:${pick(NAMES)}}}`;
  const text = (): string => Array.from({ length: 1 + Math.floor(next() * 3) }, () => (next() < 0.5 ? marker() : pick(NAMES))).join(' and ');
  const toolPart = (): Part => {
    counter += 1;
    const kind = Math.floor(next() * 6);
    const done = next() < 0.8;
    const base = { toolCallId: `call${counter}`, input: {} as Record<string, unknown>, state: done ? 'output-available' : 'input-available' };
    const records = (count: number, make: (index: number) => Record<string, unknown>) => Array.from({ length: count }, (_, index) => make(index));
    let type: string;
    let output: unknown;
    switch (kind) {
      case 0:
        type = 'tool-channels_list';
        output = { channels: records(3, () => ({ key: id(), title: pick(NAMES) })) };
        break;
      case 1:
        type = 'tool-slots_list';
        output = { slots: records(2, () => ({ screen: id(), slot: id(), label: pick(NAMES) })) };
        break;
      case 2:
        type = 'tool-rows_list';
        output = { rows: records(2, () => ({ id: id() })) };
        break;
      case 3: {
        type = 'tool-report';
        const items = records(3, () => ({ id: id(), title: pick(NAMES) }));
        output = { _result: { id: `r${Math.floor(next() * 3)}`, arrays: { items: items.length } }, items };
        break;
      }
      case 4:
        type = 'tool-read_result';
        base.input = { resultId: `r${Math.floor(next() * 3)}` };
        output = { items: records(2, () => ({ id: id(), title: pick(NAMES) })) };
        break;
      default: {
        type = 'tool-tasks_list';
        const tasks = records(3, () => ({ id: next() < 0.5 ? id() : Number(id()), title: next() < 0.1 ? '  ' : ` ${pick(NAMES)} ` }));
        output = next() < 0.5 ? { tasks } : { data: { tasks } };
      }
    }
    return { type, ...base, ...(done ? { output } : {}), ...(done ? {} : { pendingOutput: output }) };
  };
  const message = (role: 'user' | 'assistant'): Message => {
    counter += 1;
    const parts: Part[] = role === 'user'
      ? [{ type: 'text', text: text() }]
      : Array.from({ length: 1 + Math.floor(next() * 3) }, () => (next() < 0.5 ? { type: 'text', text: text() } : toolPart()));
    return { id: `m${counter}`, role, parts };
  };
  return { next, pick, text, marker, message, toolPart };
}

type Step = { messages: Message[]; searches: Searches; declarations?: EntityDeclarationsByTool; label: string };

/**
 * A sequence of conversations, each derived from the one before as a chat
 * changes it. Generated lazily: a step that changes a part in place changes
 * the conversations before it too, so each is checked before the next exists.
 */
function* conversationSteps(seed: number, count: number): Generator<Step> {
  const gen = generator(seed);
  let messages: Message[] = [];
  let searches: Searches = SEARCHES;
  let declarations: EntityDeclarationsByTool | undefined = DECLARATIONS;
  const last = () => messages[messages.length - 1];
  for (let step = 0; step < count; step += 1) {
    const roll = gen.next();
    let label: string;
    if (messages.length === 0 || roll < 0.3) {
      label = 'append';
      messages = [...messages, gen.message(messages.length % 2 === 0 ? 'user' : 'assistant')];
    } else if (roll < 0.5) {
      label = 'stream chunk (new clone)';
      const clone = structuredClone(last()!);
      const text = [...clone.parts].reverse().find((part) => part.type === 'text');
      if (text) text.text = `${String(text.text)} ${gen.next() < 0.5 ? gen.marker() : gen.pick(NAMES)}`;
      else clone.parts.push({ type: 'text', text: gen.text() });
      messages = [...messages.slice(0, -1), clone];
    } else if (roll < 0.58) {
      label = 'tool part input -> output (new clone)';
      const clone = structuredClone(last()!);
      const pending = clone.parts.find((part) => part.state === 'input-available');
      if (pending) {
        pending.state = 'output-available';
        pending.output = pending.pendingOutput;
      } else {
        clone.parts.push(gen.toolPart());
      }
      messages = [...messages.slice(0, -1), clone];
    } else if (roll < 0.63) {
      label = 'edit a message by a new object';
      const index = Math.floor(gen.next() * messages.length);
      const edited = gen.message(messages[index]!.role);
      messages = messages.map((message, at) => (at === index ? { ...edited, id: message.id } : message));
    } else if (roll < 0.66) {
      label = 'regenerate (drop the last)';
      messages = messages.slice(0, -1);
    } else if (roll < 0.69) {
      label = 'remove a middle message';
      const index = Math.floor(gen.next() * messages.length);
      messages = messages.filter((_, at) => at !== index);
    } else if (roll < 0.705) {
      label = 'clear';
      messages = [];
    } else if (roll < 0.72) {
      label = 'session switch';
      messages = Array.from({ length: 1 + Math.floor(gen.next() * 6) }, (_, at) => gen.message(at % 2 === 0 ? 'user' : 'assistant'));
    } else if (roll < 0.82) {
      label = 'part changed in place, new messages array';
      const target = messages[Math.floor(gen.next() * messages.length)]!;
      const part = target.parts[Math.floor(gen.next() * target.parts.length)]!;
      if (part.type === 'text') part.text = `${String(part.text)} ${gen.marker()}`;
      else if (part.state === 'input-available') {
        part.state = 'output-available';
        part.output = part.pendingOutput;
      } else part.output = (gen.toolPart().output ?? part.output);
      messages = [...messages];
    } else if (roll < 0.86) {
      label = 'part pushed in place, new messages array';
      const target = messages[Math.floor(gen.next() * messages.length)]!;
      target.parts.push(gen.next() < 0.5 ? { type: 'text', text: gen.text() } : gen.toolPart());
      messages = [...messages];
    } else if (roll < 0.9) {
      label = 'same messages, new array';
      messages = [...messages];
    } else if (roll < 0.93) {
      label = 'searches change';
      searches = searches.length > 0 && gen.next() < 0.5 ? [] : [...SEARCHES];
    } else if (roll < 0.96) {
      label = 'declarations change';
      declarations = gen.pick([DECLARATIONS, OTHER_DECLARATIONS, undefined]);
    } else {
      label = 'a later producer of an earlier read';
      const part = gen.toolPart();
      const items = [{ id: '9', title: gen.pick(NAMES) }];
      Object.assign(part, { type: 'tool-report', state: 'output-available', output: { _result: { id: `r${Math.floor(gen.next() * 3)}`, arrays: { items: 1 } }, items } });
      messages = [...messages, { id: `late${step}`, role: 'assistant', parts: [part] }];
    }
    yield { messages, searches, declarations, label };
  }
}

describe('entity link index against the 0.29.0 collectors', () => {
  it('the exported collectors give what 0.29.0 gave', () => {
    for (const seed of [1, 2, 3]) {
      for (const step of conversationSteps(seed, 60)) {
        expect(collectKnownEntities(step.messages, step.searches, step.declarations))
          .toEqual(released.collectKnownEntities(step.messages, step.searches, step.declarations));
        expect(collectSeenReferenceKeys(step.messages, step.searches, step.declarations))
          .toEqual(released.collectSeenReferenceKeys(step.messages, step.searches, step.declarations));
      }
    }
  });

  it('known and seen equal a full recomputation after every change, the same object while unchanged', () => {
    let checkedSame = 0;
    let changedInPlace = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const index = createConversationEntityIndex();
      let previousKnown: ReadonlyArray<ChatEntityReference> | undefined;
      let previousSeen: ReadonlySet<string> | undefined;
      let previousExpected: { known: ChatEntityReference[]; seen: string[] } | undefined;
      let at = -1;
      for (const step of conversationSteps(seed, 80)) {
        at += 1;
        const where = `seed ${seed}, step ${at} (${step.label})`;
        // A part changed in place is visible only to a recomputation from the messages' current state.
        const expected = {
          known: released.collectKnownEntities(step.messages, step.searches, step.declarations),
          seen: [...released.collectSeenReferenceKeys(step.messages, step.searches, step.declarations)].sort(),
        };
        const known = index.known(step.messages, step.searches, step.declarations);
        const seen = index.seen(step.messages, step.searches, step.declarations);
        if (step.label.includes('in place') && JSON.stringify(previousExpected) !== JSON.stringify(expected)) changedInPlace += 1;
        expect(known, where).toEqual(expected.known);
        expect([...seen].sort(), where).toEqual(expected.seen);
        if (previousExpected && JSON.stringify(previousExpected) === JSON.stringify(expected)) {
          expect(known === previousKnown, `${where}: known kept its identity`).toBe(true);
          expect(seen === previousSeen, `${where}: seen kept its identity`).toBe(true);
          checkedSame += 1;
        }
        previousKnown = known;
        previousSeen = seen;
        previousExpected = expected;
      }
    }
    // The generator does produce unchanged steps (chunks without a new name, a new array of the same messages)
    // and changes in place that change the result.
    expect(checkedSame).toBeGreaterThan(50);
    expect(changedInPlace).toBeGreaterThan(20);
  });

  it('the prepared splitter splits like 0.29.0 for every known set and option', () => {
    const compile = createRegexCache(4);
    const matchers = [
      { type: 'task', pattern: /MAR-\d+/ },
      { type: 'ticket', pattern: /#\d+/g },
      { type: 'word', pattern: /lobby/i },
    ];
    for (let seed = 1; seed <= 15; seed += 1) {
      const gen = generator(seed * 7);
      for (const step of conversationSteps(seed, 25)) {
        const known = released.collectKnownEntities(step.messages, step.searches, step.declarations);
        const resolveAmbiguous = (label: string, candidates: ReadonlyArray<ChatEntityReference>) => (label.length % 2 === 0 ? candidates[1] : undefined);
        const variants = [
          { known },
          { known, matchers, minLabelLength: 2 },
          { known, matchers, ambiguousNames: 'first' as const },
          { known, ambiguousNames: 'text' as const, resolveAmbiguous },
          { matchers },
        ];
        const texts = [
          '',
          gen.text(),
          `MAR-12 ${gen.pick(NAMES)}, #7: ${gen.pick(NAMES)} — ${gen.pick(NAMES)}.`,
          `${gen.pick(NAMES)}${gen.pick(NAMES)} MAR-3 – ${gen.pick(NAMES)} lobby LOBBY #12`,
        ];
        for (const options of variants) {
          const split = createEntityTextSplitter(options, compile);
          for (const text of texts) {
            const expected = released.splitEntityText(text, options);
            expect(split(text)).toEqual(expected);
            expect(splitEntityText(text, options)).toEqual(expected);
          }
        }
      }
    }
  });

  it('resolveAmbiguous is asked on every split, as in 0.29.0: a picker reading outside state switches with it', () => {
    const known: ChatEntityReference[] = [
      { type: 'playlist', id: '1', label: 'Lobby Loop' },
      { type: 'playlist', id: '2', label: 'Lobby Loop' },
      { type: 'channel', id: '3', label: 'Main Hall' },
    ];
    let choice = 0;
    const calls = { released: 0, prepared: 0 };
    const picker = (counter: 'released' | 'prepared') => (_label: string, candidates: ReadonlyArray<ChatEntityReference>) => {
      calls[counter] += 1;
      return candidates[choice];
    };
    const split = createEntityTextSplitter({ known, resolveAmbiguous: picker('prepared') }, createRegexCache());
    const ids = (segments: ReturnType<typeof splitEntityText>) => segments.flatMap((segment) => (segment.kind === 'entity' ? [segment.reference.id] : []));
    const text = 'Lobby Loop runs in Main Hall';
    for (const next of [0, 1, 1, 0, 5]) {
      choice = next;
      const expected = released.splitEntityText(text, { known, resolveAmbiguous: picker('released') });
      expect(split(text)).toEqual(expected);
      expect(ids(split(text))).toEqual(ids(expected));
      split(text);
    }
    expect(ids(released.splitEntityText(text, { known, resolveAmbiguous: () => known[1] }))).toEqual(['2', '3']);
    // Once per split and ambiguous name, like 0.29.0 (three splits per round here, one there).
    expect(calls.prepared).toBe(3 * calls.released);
  });

  it('a known name renamed in the streaming message (same count) is the new name', () => {
    const index = createConversationEntityIndex();
    const searches: Searches = [];
    const settled: Message = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Is {{mention:channel:c1:Lobby}} live?' }] };
    const streaming = (label: string): Message => ({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: `Yes, {{mention:channel:c2:${label}}}` }] });
    for (const label of ['Main', 'Main hall', 'Main hall', 'Back office']) {
      const messages = [settled, streaming(label)];
      expect(index.known(messages, searches)).toEqual(released.collectKnownEntities(messages, searches));
      expect(index.known([...messages], searches).map((reference) => reference.label)).toEqual(['Lobby', label]);
    }
    // A settled message renamed by a new object (an edit) as well.
    const edited: Message = { ...settled, parts: [{ type: 'text', text: 'Is {{mention:channel:c1:Lobby screens}} live?' }] };
    expect(index.known([edited, streaming('Back office')], searches).map((reference) => reference.label)).toEqual(['Lobby screens', 'Back office']);
  });

  it('the regex cache tells patterns apart by their flags', () => {
    const compile = createRegexCache();
    const plain = compile('lobby', 'gu');
    const folded = compile('lobby', 'giu');
    expect(plain.flags).toBe('gu');
    expect(folded.flags).toBe('giu');
    expect(compile('lobby', 'gu')).toBe(plain);
  });

  it('sameReferences compares data too', () => {
    const base = { type: 'slot', id: 'a/b', label: 'Lobby' };
    expect(sameReferences([{ ...base, data: { idValues: ['a', 'b'] } }], [{ ...base, data: { idValues: ['a', 'b'] } }])).toBe(true);
    expect(sameReferences([{ ...base, data: { idValues: ['a', 'b'] } }], [{ ...base, data: { idValues: ['a', 'c'] } }])).toBe(false);
    expect(sameReferences([base], [{ ...base, data: { floor: 2 } }])).toBe(false);
    const when = new Date(0);
    expect(sameReferences([{ ...base, data: { when } }], [{ ...base, data: { when: new Date(0) } }])).toBe(false);
  });
});

/**
 * A part changed in place on the same message object, with a new messages
 * array: each field the cache's shape check reads, one at a time.
 */
describe('entity link index notices a part changed in place', () => {
  const declarations: EntityDeclarationsByTool = {
    channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
    rooms_list: { output: [{ type: 'room', id: 'key', name: 'title', path: 'channels[]' }] },
    report: { output: [{ type: 'task', id: 'id', name: 'title' }] },
  };
  const channels = { channels: [{ key: 'c1', title: 'Lobby screens' }] };

  // One searches array for every call, as the provider passes it: a new one would read every message again.
  const searches: Searches = [];

  function check(messages: Message[], change: () => void) {
    const index = createConversationEntityIndex();
    const run = () => {
      const current = [...messages];
      expect(index.known(current, searches, declarations)).toEqual(released.collectKnownEntities(current, searches, declarations));
      expect([...index.seen(current, searches, declarations)].sort())
        .toEqual([...released.collectSeenReferenceKeys(current, searches, declarations)].sort());
      return [released.collectKnownEntities(current, searches, declarations), [...released.collectSeenReferenceKeys(current, searches, declarations)]];
    };
    const before = JSON.stringify(run());
    change();
    const after = JSON.stringify(run());
    // The change must matter, or the case proves nothing.
    expect(after).not.toBe(before);
  }

  it('state', () => {
    const part: Part = { type: 'tool-channels_list', toolCallId: 't', state: 'input-available', input: {}, output: channels };
    check([{ id: 'a', role: 'assistant', parts: [part] }], () => { part.state = 'output-available'; });
  });

  it('input (a read_result reading another result)', () => {
    const producer = (id: string, title: string): Part => ({
      type: 'tool-report', toolCallId: id, state: 'output-available', input: {},
      output: { _result: { id, arrays: { items: 1 } }, items: [{ id, title }] },
    });
    const read: Part = { type: 'tool-read_result', toolCallId: 'read', state: 'output-available', input: { resultId: 'r1' }, output: { items: [{ id: 'x', title: 'Read row' }] } };
    const messages: Message[] = [
      { id: 'p', role: 'assistant', parts: [producer('r1', 'One'), { ...producer('r2', 'Two'), type: 'tool-rooms_list' }] },
      { id: 'a', role: 'assistant', parts: [read] },
    ];
    check(messages, () => { read.input = { resultId: 'r2' }; });
  });

  it('role', () => {
    const message: Message = { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'See {{mention:channel:c9:Lobby}}' }] };
    check([message], () => { message.role = 'user'; });
  });

  it('result (a part with toolName and result)', () => {
    const part: Part = { type: 'tool-result', toolName: 'channels_list', result: { channels: [] } };
    check([{ id: 'a', role: 'assistant', parts: [part] }], () => { part.result = channels; });
  });

  it('toolName', () => {
    const part: Part = { type: 'tool-result', toolName: 'channels_list', result: channels };
    check([{ id: 'a', role: 'assistant', parts: [part] }], () => { part.toolName = 'rooms_list'; });
  });
});

