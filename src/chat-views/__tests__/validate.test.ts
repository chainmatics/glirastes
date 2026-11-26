import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatViewSpec } from '../../contracts/chat-view.js';
import {
  bindable,
  defineChatComponent,
  effectiveChatManifest,
  mergeChatManifests,
  starterChatComponentManifest,
  toChatComponentManifest,
  validateChatViewSpec,
} from '../index.js';

const manifest = starterChatComponentManifest;

function errorsOf(spec: unknown, options?: { surface?: 'narrow' | 'workspace' }): string[] {
  const result = validateChatViewSpec(spec, manifest, options);
  if (result.ok) throw new Error('expected the spec to be rejected');
  return result.errors;
}

const ref = (path: string) => ({ $ref: 'call_1', path });

function tableSpec(columnCount: number): ChatViewSpec {
  const elements: ChatViewSpec['elements'] = {
    table: {
      type: 'Table',
      props: {
        rows: ref('data[]'),
        columns: Array.from({ length: columnCount }, (_, i) => ({ header: `C${i}`, cell: `c${i}` })),
      },
    },
  };
  for (let i = 0; i < columnCount; i += 1) {
    elements[`c${i}`] = { type: 'StatusBadge', props: { label: { $item: `f${i}` }, tone: 'neutral' } };
  }
  return { root: 'table', elements };
}

const validSpec: ChatViewSpec = {
  root: 'root',
  caption: 'Open invoices',
  elements: {
    root: { type: 'Group', props: { emphasis: 'subtle' }, children: ['card', 'stat', 'act'] },
    card: { type: 'Card', props: { title: 'Invoices' }, children: ['table', 'kv'] },
    table: {
      type: 'Table',
      props: {
        rows: ref('data[]'),
        columns: [
          { header: 'Customer', cell: 'cust' },
          { header: 'Status', cell: 'status' },
          { header: 'Total', cell: 'total' },
        ],
      },
    },
    cust: {
      type: 'EntityLink',
      props: { entity: 'customer', record: { $item: 'customerId' }, label: { $item: 'customer' } },
    },
    status: { type: 'StatusBadge', props: { label: { $item: 'status' }, tone: 'warning' } },
    total: { type: 'Money', props: { amount: { $item: 'total' }, currency: 'EUR' } },
    kv: {
      type: 'KeyValue',
      props: { items: [{ label: 'Count', value: 4 }, { label: 'Owner', value: ref('owner') }] },
    },
    stat: { type: 'Stat', props: { label: 'Open', value: { $count: ref('data[]') } } },
    act: {
      type: 'Action',
      props: { label: 'Remind', uiAction: { id: 'remind', args: { id: ref('data[0].id'), all: true } } },
    },
  },
};

describe('validateChatViewSpec', () => {
  it('accepts a valid starter spec', () => {
    const result = validateChatViewSpec(validSpec, manifest);
    expect(result).toEqual({ ok: true, spec: validSpec });
  });

  it('accepts a 3-column table on a narrow surface and $said on Stat.value', () => {
    const spec = tableSpec(3);
    spec.elements.said = {
      type: 'Stat',
      props: { label: 'Total', value: { $said: '12.400 €', basis: ref('data[]') } },
    };
    spec.elements.g = { type: 'Group', props: {}, children: ['table', 'said'] };
    spec.root = 'g';
    expect(validateChatViewSpec(spec, manifest, { surface: 'narrow' }).ok).toBe(true);
  });

  it('rejects an unknown component and lists the known ones', () => {
    const errors = errorsOf({ root: 'a', elements: { a: { type: 'Tabel', props: {} } } });
    expect(errors).toEqual([
      'element "a": unknown component "Tabel" (known: Group, Card, Text, KeyValue, Table, StatusBadge, EntityLink, Money, DateTime, Stat, Action)',
    ]);
  });

  it('rejects a missing root and a missing child', () => {
    expect(errorsOf({ root: 'x', elements: { a: { type: 'Group', props: {} } } })).toContain(
      'root "x" is not an element',
    );
    expect(
      errorsOf({ root: 'a', elements: { a: { type: 'Group', props: {}, children: ['b'] } } }),
    ).toContain('element "a" (Group): child "b" is not an element');
  });

  it('rejects a missing table cell element', () => {
    const spec = tableSpec(2);
    delete spec.elements.c1;
    expect(errorsOf(spec)).toContain('element "table" (Table): columns[1].cell "c1" is not an element');
  });

  it('rejects a cycle', () => {
    const errors = errorsOf({
      root: 'a',
      elements: {
        a: { type: 'Group', props: {}, children: ['b'] },
        b: { type: 'Group', props: {}, children: ['a'] },
      },
    });
    expect(errors).toContain('cycle: element "b" (Group) contains "a", which contains it');
  });

  it('rejects depth 7 and accepts depth 6', () => {
    const chain = (depth: number): ChatViewSpec => {
      const elements: ChatViewSpec['elements'] = {};
      for (let i = 1; i <= depth; i += 1) {
        elements[`e${i}`] =
          i < depth
            ? { type: 'Group', props: {}, children: [`e${i + 1}`] }
            : { type: 'Text', props: { text: 'leaf' } };
      }
      return { root: 'e1', elements };
    };
    expect(validateChatViewSpec(chain(6), manifest).ok).toBe(true);
    expect(errorsOf(chain(7))).toContain('element "e7" is at depth 7; the maximum depth is 6');
  });

  it('rejects 61 elements', () => {
    const elements: ChatViewSpec['elements'] = {
      root: { type: 'Group', props: {}, children: [] },
    };
    for (let i = 0; i < 60; i += 1) {
      elements[`t${i}`] = { type: 'Text', props: { text: 'x' } };
      elements.root!.children!.push(`t${i}`);
    }
    expect(errorsOf({ root: 'root', elements })).toContain(
      'the view has 61 elements; the maximum is 60',
    );
  });

  it('rejects a spec over 8192 bytes', () => {
    const spec = tableSpec(1);
    spec.elements.c0!.props = { text: 'x'.repeat(9000) };
    expect(errorsOf(spec)[0]).toMatch(/^the spec has \d+ bytes; the maximum is 8192$/);
  });

  it('rejects 9 table columns', () => {
    expect(errorsOf(tableSpec(9))).toContain(
      'element "table" (Table): 9 columns exceed the limit of 8',
    );
  });

  it('rejects 4 table columns on a narrow surface only', () => {
    expect(validateChatViewSpec(tableSpec(4), manifest, { surface: 'workspace' }).ok).toBe(true);
    expect(errorsOf(tableSpec(4), { surface: 'narrow' })).toContain(
      'element "table" (Table): 4 columns exceed the limit of 3 on a narrow surface',
    );
  });

  it('rejects $said in a table cell with a $count/$sum hint', () => {
    const spec = tableSpec(1);
    spec.elements.c0 = {
      type: 'Money',
      props: { amount: { $said: '12 €', basis: ref('data[]') }, currency: 'EUR' },
    };
    expect(errorsOf(spec)).toContain(
      'element "c0" (Money): amount: "$said" is only allowed in Stat.value; use {"$count": …} or {"$sum": …}',
    );
  });

  it('rejects $count outside Stat.value', () => {
    const errors = errorsOf({
      root: 'm',
      elements: { m: { type: 'Money', props: { amount: { $sum: ref('data[].total') }, currency: 'EUR' } } },
    });
    expect(errors).toContain('element "m" (Money): amount: "$sum" is only allowed in Stat.value');
  });

  it('rejects $item outside a table cell element', () => {
    const errors = errorsOf({
      root: 'g',
      elements: {
        g: { type: 'Group', props: {}, children: ['s'] },
        s: { type: 'StatusBadge', props: { label: { $item: 'status' }, tone: 'neutral' } },
      },
    });
    expect(errors).toContain(
      'element "s" (StatusBadge): label: "$item" is only allowed in the cell element of a Table column; use {"$ref": "<toolCallId>", "path": "…"}',
    );
  });

  it('rejects references on props that are not bindable', () => {
    const errors = errorsOf({
      root: 'c',
      elements: { c: { type: 'Card', props: { title: ref('title') } } },
    });
    expect(errors).toContain(
      'element "c" (Card): title: references are only allowed on bindable props (Card has none)',
    );
  });

  it('rejects literals on reference-only props', () => {
    const spec = tableSpec(1);
    spec.elements.table!.props.rows = [{ a: 1 }];
    expect(errorsOf(spec)).toContain(
      'element "table" (Table): rows: only accepts a reference {"$ref": "<toolCallId>", "path": "…"}',
    );
  });

  it('rejects malformed references', () => {
    const errors = errorsOf({
      root: 's',
      elements: { s: { type: 'Stat', props: { label: 'x', value: { $ref: 'call_1' } } } },
    });
    expect(errors).toContain(
      'element "s" (Stat): value: invalid reference; expected {"$ref": "<toolCallId>", "path": "…"}',
    );
  });

  it('validates literal props against the component schema', () => {
    const errors = errorsOf({
      root: 'g',
      elements: {
        g: { type: 'Group', props: {}, children: ['m', 'c', 'b'] },
        m: { type: 'Money', props: { amount: '12', currency: 'euro', color: 'red' } },
        c: { type: 'Card', props: {} },
        b: { type: 'StatusBadge', props: { label: 'ok', tone: 'blue' } },
      },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'element "m" (Money): unknown prop "color" (allowed: amount, currency)',
        'element "m" (Money): amount: expected number',
        'element "m" (Money): currency: must match ^[A-Z]{3}$',
        'element "c" (Card): missing required prop "title"',
        'element "b" (StatusBadge): tone: must be one of "neutral", "success", "warning", "danger"',
      ]),
    );
  });

  it('rejects literal strings over 200 characters', () => {
    const errors = errorsOf({
      root: 't',
      elements: { t: { type: 'Text', props: { text: 'x'.repeat(201) } } },
    });
    expect(errors).toContain('element "t" (Text): text: string has 201 characters; the maximum is 200');
  });

  it('rejects children on a component without children and disallowed child types', () => {
    const narrowCatalog = mergeChatManifests(
      manifest,
      toChatComponentManifest([
        defineChatComponent({
          id: 'Row',
          schemaVersion: 1,
          description: 'Row of stats',
          props: z.object({}),
          children: ['Stat'],
          text: {},
        }),
      ]),
    );
    const result = validateChatViewSpec(
      {
        root: 'r',
        elements: {
          r: { type: 'Row', props: {}, children: ['t'] },
          t: { type: 'Text', props: { text: 'x' }, children: ['u'] },
          u: { type: 'Text', props: { text: 'y' } },
        },
      },
      narrowCatalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('element "r" (Row): child "t" is a Text; allowed: Stat');
    expect(result.errors).toContain('element "t" (Text): Text takes no children');
  });

  it('rejects an Action with both or no targets', () => {
    const both = errorsOf({
      root: 'a',
      elements: { a: { type: 'Action', props: { label: 'Go', prompt: 'go', uiAction: { id: 'x' } } } },
    });
    expect(both).toContain('element "a" (Action): needs exactly one target, "prompt" or "uiAction"');
    const none = errorsOf({ root: 'a', elements: { a: { type: 'Action', props: { label: 'Go' } } } });
    expect(none).toContain('element "a" (Action): needs exactly one target, "prompt" or "uiAction"');
  });

  it('rejects elements not reachable from the root and elements with two parents', () => {
    const errors = errorsOf({
      root: 'g',
      elements: {
        g: { type: 'Group', props: {}, children: ['t', 't'] },
        t: { type: 'Text', props: { text: 'x' } },
        lost: { type: 'Text', props: { text: 'y' } },
      },
    });
    expect(errors).toContain('element "lost" is not reachable from the root "g"');
    expect(errors).toContain('element "t" is used more than once; every element has one place');
  });

  it('rejects a structurally invalid spec with the contract path', () => {
    expect(errorsOf({ root: 'a', elements: { a: { type: 'Text' } } })[0]).toMatch(
      /^spec\.elements\.a\.props: /,
    );
  });

  it('does not allow operators on app components', () => {
    const appManifest = toChatComponentManifest([
      defineChatComponent({
        id: 'Kpi',
        schemaVersion: 1,
        description: 'KPI',
        props: z.object({ value: bindable(z.number()) }),
        text: { value: 'value' },
      }),
    ]);
    const result = validateChatViewSpec(
      { root: 'k', elements: { k: { type: 'Kpi', props: { value: { $count: ref('data[]') } } } } },
      appManifest,
    );
    expect(result).toEqual({
      ok: false,
      errors: ['element "k" (Kpi): value: "$count" is only allowed in Stat.value'],
    });
  });
});

it('fails closed on JSON Schema keywords it does not support', () => {
  const custom = {
    v: 1 as const,
    components: [
      {
        id: 'Odd',
        schemaVersion: 1,
        description: 'odd',
        props: { type: 'object', properties: { n: { type: 'number', multipleOf: 2 } } },
        bindable: [],
        refOnly: [],
        children: 'none' as const,
        text: {},
      },
    ],
  };
  const result = validateChatViewSpec(
    { root: 'o', elements: { o: { type: 'Odd', props: { n: 4 } } } },
    custom,
  );
  expect(result).toEqual({
    ok: false,
    errors: ['element "o" (Odd): n: component Odd uses the unsupported schema keyword "multipleOf"; it cannot be validated'],
  });
});

describe('effectiveChatManifest', () => {
  it('returns the manifest unchanged without a component list', () => {
    expect(effectiveChatManifest(manifest)).toEqual(manifest);
    expect(effectiveChatManifest(manifest, { surface: 'narrow' })).toEqual(manifest);
  });

  it('intersects by id@schemaVersion and never adds entries', () => {
    const effective = effectiveChatManifest(manifest, {
      components: [
        { id: 'Group', schemaVersion: 1 },
        { id: 'Text', schemaVersion: 1 },
        { id: 'Table', schemaVersion: 2 },
        { id: 'Chart', schemaVersion: 1 },
      ],
    });
    expect(effective.components.map((c) => c.id)).toEqual(['Group', 'Text']);
  });

  it('a spec using Table fails once the client drops Table', () => {
    const effective = effectiveChatManifest(manifest, {
      components: manifest.components
        .filter((c) => c.id !== 'Table')
        .map(({ id, schemaVersion }) => ({ id, schemaVersion })),
    });
    const result = validateChatViewSpec(tableSpec(2), effective);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^element "table": unknown component "Table" \(known: Group, /);
  });
});
