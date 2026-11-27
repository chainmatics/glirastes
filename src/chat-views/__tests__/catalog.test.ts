import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatComponentManifestSchema } from '../../contracts/chat-view.js';
import {
  bindable,
  defineChatComponent,
  describeChatCatalog,
  mergeChatManifests,
  refOnly,
  starterChatComponentManifest,
  starterChatComponents,
  toChatComponentManifest,
} from '../index.js';

const textComponent = (id: string, schemaVersion = 1, description = 'A text.') =>
  defineChatComponent({
    id,
    schemaVersion,
    description,
    props: z.object({ text: z.string() }),
    text: { value: 'text' },
  });

describe('starter catalog', () => {
  it('starter manifest is valid against chatComponentManifestSchema', () => {
    expect(chatComponentManifestSchema.safeParse(starterChatComponentManifest).success).toBe(true);
    expect(starterChatComponentManifest).toEqual(toChatComponentManifest(starterChatComponents));
    expect(starterChatComponentManifest.components.map((c) => c.id)).toEqual([
      'Group',
      'Card',
      'Text',
      'KeyValue',
      'Table',
      'StatusBadge',
      'EntityLink',
      'Money',
      'DateTime',
      'Stat',
      'Action',
    ]);
    expect(starterChatComponentManifest.components.every((c) => c.schemaVersion === 1)).toBe(true);
  });

  it('carries bindable and refOnly marks as prop paths', () => {
    const byId = new Map(starterChatComponentManifest.components.map((c) => [c.id, c]));
    expect(byId.get('Table')).toMatchObject({
      refOnly: ['rows'],
      bindable: [],
      itemScope: { rowsProp: 'rows', cellsProp: 'columns' },
    });
    expect(byId.get('EntityLink')).toMatchObject({ refOnly: ['record'], bindable: ['label'] });
    expect(byId.get('Money')).toMatchObject({ bindable: ['amount', 'currency'], refOnly: [] });
    expect(byId.get('Stat')).toMatchObject({ bindable: ['value'] });
    expect(byId.get('KeyValue')).toMatchObject({ bindable: ['items[].value'] });
    expect(byId.get('Action')).toMatchObject({ bindable: ['uiAction.args.*'] });
    // The JSON Schema of a bindable prop describes the plain value type.
    const money = byId.get('Money')!.props as { properties: Record<string, unknown> };
    expect(money.properties.amount).toEqual({ type: 'number' });
    // Unknown props are rejected, at every object level.
    expect(money).toMatchObject({ additionalProperties: false });
    const keyValue = byId.get('KeyValue')!.props as {
      properties: { items: { items: Record<string, unknown> } };
    };
    expect(keyValue.properties.items.items).toMatchObject({ additionalProperties: false });
  });

  it('Text takes only its text (Text@1 is public contract)', () => {
    const text = starterChatComponentManifest.components.find((c) => c.id === 'Text')!;
    expect(text.props).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    });
  });

  it('Action accepts at most label ≤ 40 and both optional targets in the schema', () => {
    const action = starterChatComponents.find((c) => c.id === 'Action')!;
    expect(action.props.safeParse({ label: 'x'.repeat(41), prompt: 'go' }).success).toBe(false);
    expect(action.props.safeParse({ label: 'Open', uiAction: { id: 'open', args: { a: 1 } } }).success).toBe(true);
  });
});

describe('defineChatComponent', () => {
  it('rejects an invalid id or schema version', () => {
    expect(() => textComponent('lower')).toThrow(/id/);
    expect(() => textComponent('Bad-Id')).toThrow(/id/);
    expect(() => textComponent('Ok', 1.5)).toThrow(/schemaVersion/);
    expect(() => textComponent('Ok', 0)).toThrow(/schemaVersion/);
  });

  it('rejects text rules that name an unknown prop', () => {
    expect(() =>
      defineChatComponent({
        id: 'Broken',
        schemaVersion: 1,
        description: 'x',
        props: z.object({ text: z.string() }),
        text: { value: 'missing' },
      }),
    ).toThrow(/missing/);
  });

  it('does not mark a schema the caller reuses elsewhere', () => {
    const shared = z.string();
    const def = defineChatComponent({
      id: 'Marks',
      schemaVersion: 1,
      description: 'x',
      props: z.object({ a: bindable(shared), b: shared, c: refOnly().optional() }),
      text: {},
    });
    const [entry] = toChatComponentManifest([def]).components;
    expect(entry).toMatchObject({ bindable: ['a'], refOnly: ['c'] });
  });
});

describe('toChatComponentManifest', () => {
  it('duplicate id@version throws', () => {
    expect(() => toChatComponentManifest([textComponent('Note'), textComponent('Note')])).toThrow(/Note@1/);
    expect(() => toChatComponentManifest([textComponent('Note'), textComponent('Note', 2)])).not.toThrow();
  });

  it('refinement in props throws', () => {
    const refined = defineChatComponent({
      id: 'Refined',
      schemaVersion: 1,
      description: 'x',
      props: z.object({ text: z.string().refine((value) => value.length > 2) }),
      text: { value: 'text' },
    });
    expect(() => toChatComponentManifest([refined])).toThrow(/Refined/);
    const transformed = defineChatComponent({
      id: 'Transformed',
      schemaVersion: 1,
      description: 'x',
      props: z.object({ text: z.string().transform((value) => value.trim()) }),
      text: { value: 'text' },
    });
    expect(() => toChatComponentManifest([transformed])).toThrow(/Transformed/);
  });
});

describe('mergeChatManifests', () => {
  it('replaces entries by id@schemaVersion and keeps the others', () => {
    const a = toChatComponentManifest([textComponent('Note', 1, 'old'), textComponent('Other')]);
    const b = toChatComponentManifest([textComponent('Note', 1, 'new'), textComponent('Note', 2), textComponent('Extra')]);
    const merged = mergeChatManifests(a, b);
    expect(merged.v).toBe(1);
    expect(merged.components.map((c) => `${c.id}@${c.schemaVersion}:${c.description}`)).toEqual([
      'Note@1:new',
      'Other@1:A text.',
      'Note@2:A text.',
      'Extra@1:A text.',
    ]);
  });
});

describe('describeChatCatalog', () => {
  it('defers to app presentation instructions and the requested output format', () => {
    const text = describeChatCatalog(starterChatComponentManifest);
    expect(text).toContain("Follow the app's presentation instructions");
    expect(text).not.toMatch(/≥\s*4|at least four/i);
  });

  it('describeChatCatalog(starter) stays under 2400 characters', () => {
    expect(describeChatCatalog(starterChatComponentManifest).length).toBeLessThan(2400);
  });

  it('describeChatCatalog contains every component id once', () => {
    const text = describeChatCatalog(starterChatComponentManifest);
    for (const { id } of starterChatComponentManifest.components) {
      const signatures = text.split('\n').filter((line) => line.startsWith(`${id}(`));
      expect(signatures, id).toHaveLength(1);
    }
  });

  it('states the usage rules, the reference grammar and typed signatures', () => {
    const text = describeChatCatalog(starterChatComponentManifest);
    expect(text).toMatch(/One view per turn/);
    expect(text).toMatch(/\$ref/);
    expect(text).toMatch(/\$item/);
    expect(text).toMatch(/\$said/);
    expect(text).toContain('Table(rows:ref[], columns:[{header, cell:#id}]≤8)');
    expect(text).toContain("tone:'neutral'|'success'|'warning'|'danger'");
  });
});
