import { describe, expect, it } from 'vitest';
import {
  CHAT_VIEW_LIMITS,
  resolvedChatViewSchema,
  type ChatViewSpec,
} from '../../contracts/chat-view.js';
import {
  resolveChatView,
  starterChatComponentManifest,
  validateChatViewSpec,
  type ChatViewSourceLookup,
} from '../index.js';

const manifest = starterChatComponentManifest;

type Source = { toolName: string; value: unknown; truncated: boolean };

function lookupOf(sources: Record<string, Source>): ChatViewSourceLookup {
  return async (toolCallId) => sources[toolCallId];
}

function invoices(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `inv_${i}`,
    customer: i === 0 ? '«PERSON_1»' : `Customer ${i}`,
    total: (i + 1) * 10,
    currency: 'EUR',
    secret: 'not referenced',
  }));
}

const source = (value: unknown, truncated = false): Source => ({ toolName: 'list_invoices', value, truncated });

async function resolve(spec: ChatViewSpec, sources: Record<string, Source>) {
  const validated = validateChatViewSpec(spec, manifest);
  if (!validated.ok) throw new Error(`spec invalid: ${validated.errors.join('; ')}`);
  return resolveChatView(validated.spec, manifest, lookupOf(sources));
}

async function errorsOf(spec: ChatViewSpec, sources: Record<string, Source>): Promise<string[]> {
  const result = await resolve(spec, sources);
  if (result.ok) throw new Error('expected the view to be rejected');
  return result.errors;
}

const ref = (path: string, id = 'call_1') => ({ $ref: id, path });

function tableSpec(rowsPath = 'data[]'): ChatViewSpec {
  return {
    root: 'card',
    caption: 'Open invoices',
    elements: {
      card: { type: 'Card', props: { title: 'Invoices' }, children: ['table'] },
      table: {
        type: 'Table',
        props: {
          rows: ref(rowsPath),
          columns: [
            { header: 'Customer', cell: 'customer' },
            { header: 'Total', cell: 'total' },
          ],
        },
      },
      customer: { type: 'StatusBadge', props: { label: { $item: 'customer' }, tone: 'neutral' } },
      total: { type: 'Money', props: { amount: { $item: 'total' }, currency: { $item: 'currency' } } },
    },
  };
}

function statSpec(value: unknown): ChatViewSpec {
  return { root: 'stat', elements: { stat: { type: 'Stat', props: { label: 'Total', value } } } };
}

describe('resolveChatView', () => {
  it('resolves table rows and $item cells, keyed by cell element id', async () => {
    const result = await resolve(tableSpec(), { call_1: source({ data: invoices(2) }) });
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { view, sources } = result;
    expect(resolvedChatViewSchema.parse(view)).toEqual(view);
    expect(sources).toEqual(['call_1']);
    expect(view).toMatchObject({ v: 1, root: 'card', caption: 'Open invoices' });
    expect(view.elements.card).toEqual({
      type: 'Card',
      schemaVersion: 1,
      props: { title: 'Invoices' },
      children: ['table'],
    });
    const table = view.elements.table!;
    expect(table.props).toEqual({
      columns: [
        { header: 'Customer', cell: 'customer' },
        { header: 'Total', cell: 'total' },
      ],
    });
    expect(table.rows).toEqual([
      {
        customer: { label: '«PERSON_1»', tone: 'neutral' },
        total: { amount: 10, currency: 'EUR' },
      },
      {
        customer: { label: 'Customer 1', tone: 'neutral' },
        total: { amount: 20, currency: 'EUR' },
      },
    ]);
    // Only referenced fields reach the view.
    expect(JSON.stringify(view)).not.toContain('not referenced');
    expect(view.elements.total).toEqual({ type: 'Money', schemaVersion: 1, props: {} });
    expect(view.elements.customer).toEqual({
      type: 'StatusBadge',
      schemaVersion: 1,
      props: { tone: 'neutral' },
    });
  });

  it('accepts the rows path with or without []', async () => {
    const result = await resolve(tableSpec('data'), { call_1: source({ data: invoices(3) }) });
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.view.elements.table!.rows).toHaveLength(3);
  });

  it('resolves $count and $sum deterministically', async () => {
    const lookup = { call_1: source({ data: invoices(4) }) };
    const count = await resolve(statSpec({ $count: ref('data[]') }), lookup);
    const sum = await resolve(statSpec({ $sum: ref('data[].total') }), lookup);
    if (!count.ok || !sum.ok) throw new Error('expected both to resolve');
    expect(count.view.elements.stat!.props.value).toBe(4);
    expect(sum.view.elements.stat!.props.value).toBe(100);
    expect(count.view.elements.stat!.said).toBeUndefined();
  });

  it('rejects $sum over non-numbers', async () => {
    const errors = await errorsOf(statSpec({ $sum: ref('data[].customer') }), {
      call_1: source({ data: invoices(2) }),
    });
    expect(errors.join('\n')).toContain('"$sum"');
    expect(errors.join('\n')).toContain('data[].customer');
  });

  it('rejects $count over something that is not a list', async () => {
    const errors = await errorsOf(statSpec({ $count: ref('meta.name') }), {
      call_1: source({ meta: { name: 'x' } }),
    });
    expect(errors.join('\n')).toContain('not a list');
  });

  it('keeps $said text and marks the element said once its basis resolves', async () => {
    const result = await resolve(statSpec({ $said: '12.400 €', basis: ref('data[].total') }), {
      call_1: source({ data: invoices(2) }),
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.view.elements.stat).toEqual({
      type: 'Stat',
      schemaVersion: 1,
      props: { label: 'Total', value: '12.400 €' },
      said: true,
    });
    expect(result.sources).toEqual(['call_1']);
  });

  it('rejects $said whose basis does not resolve', async () => {
    const errors = await errorsOf(statSpec({ $said: '12.400 €', basis: ref('data[].nope') }), {
      call_1: source({ data: invoices(2) }),
    });
    expect(errors.join('\n')).toContain('path "data[].nope" is not in the result of call_1');
  });

  it('reports an unknown call id', async () => {
    const errors = await errorsOf(statSpec({ $count: ref('data[]', 'call_x') }), {});
    expect(errors.join('\n')).toContain('no tool result "call_x" in this conversation');
  });

  it('resolve: missing path names read_result (truncated source)', async () => {
    const spec = tableSpec();
    spec.elements.customer = { type: 'StatusBadge', props: { label: { $item: 'foo' }, tone: 'neutral' } };
    const errors = await errorsOf(spec, { call_1: source({ data: invoices(3) }, true) });
    expect(errors.join('\n')).toContain(
      'path "data[].foo" is not in the shown result of call_1; call read_result for these fields first, then reference the read_result call',
    );
  });

  it('names the fields that exist when a path of a complete result is missing', async () => {
    const errors = await errorsOf(statSpec({ $sum: ref('data[].amount') }), {
      call_1: source({ data: invoices(2) }),
    });
    const text = errors.join('\n');
    expect(text).toContain('path "data[].amount" is not in the result of call_1');
    expect(text).toContain('total');
    expect(text).not.toContain('read_result');
  });

  it('rejects a path outside the read_result grammar', async () => {
    const errors = await errorsOf(statSpec({ $count: ref('data..x') }), {
      call_1: source({ data: invoices(2) }),
    });
    expect(errors.join('\n')).toContain('path "data..x" is not a valid path');
  });

  it('refuses $count and $sum over a cut result', async () => {
    const errors = await errorsOf(statSpec({ $count: ref('data[]') }), {
      call_1: source({ data: invoices(3) }, true),
    });
    expect(errors.join('\n')).toContain('read_result');
  });

  it(`caps table rows at ${CHAT_VIEW_LIMITS.maxTableRows} and records the rest as truncatedRows`, async () => {
    const result = await resolve(tableSpec(), { call_1: source({ data: invoices(120) }) });
    if (!result.ok) throw new Error(result.errors.join('; '));
    const table = result.view.elements.table!;
    expect(table.rows).toHaveLength(50);
    expect(table.props.truncatedRows).toBe(70);
    expect(result.view.caption).toBe('Open invoices');
  });

  it('rejects a view whose projection is too large', async () => {
    const huge = invoices(50).map((row) => ({ ...row, customer: 'x'.repeat(2000) }));
    const errors = await errorsOf(tableSpec(), { call_1: source({ data: huge }) });
    expect(errors).toEqual(['view too large; reference fewer fields or rows']);
  });

  it('copies values unchanged: a pseudonym stays identical', async () => {
    const spec: ChatViewSpec = {
      root: 'kv',
      elements: {
        kv: {
          type: 'KeyValue',
          props: {
            items: [
              { label: 'Customer', value: ref('data[0].customer') },
              { label: 'Literal', value: '«PERSON_2»' },
            ],
          },
        },
      },
    };
    const result = await resolve(spec, { call_1: source({ data: invoices(1) }) });
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.view.elements.kv!.props.items).toEqual([
      { label: 'Customer', value: '«PERSON_1»' },
      { label: 'Literal', value: '«PERSON_2»' },
    ]);
  });

  it('looks each source up once and lists sources in first-use order', async () => {
    const calls: string[] = [];
    const spec: ChatViewSpec = {
      root: 'group',
      elements: {
        group: { type: 'Group', props: {}, children: ['a', 'b', 'c'] },
        a: { type: 'Stat', props: { label: 'A', value: { $count: ref('data[]', 'call_2') } } },
        b: { type: 'Stat', props: { label: 'B', value: { $count: ref('data[]', 'call_1') } } },
        c: { type: 'Stat', props: { label: 'C', value: { $sum: ref('data[].total', 'call_2') } } },
      },
    };
    const validated = validateChatViewSpec(spec, manifest);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    const sources: Record<string, Source> = {
      call_1: source({ data: invoices(1) }),
      call_2: source({ data: invoices(2) }),
    };
    const result = await resolveChatView(validated.spec, manifest, async (id) => {
      calls.push(id);
      return sources[id];
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.sources).toEqual(['call_2', 'call_1']);
    expect(calls).toEqual(['call_2', 'call_1']);
  });
});
