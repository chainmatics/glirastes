// An app module on zod 3.25 declaring chat components with the bundled
// 'zod/v4' build, typechecked against the BUILT glirastes declarations
// (which use zod 4 from the SDK's own node_modules) by
// tests/zod3-chat-views.test.ts under a 1 GB heap.
import { z as z3 } from 'zod';
import { z } from 'zod/v4';
import {
  bindable,
  chatElementId,
  defineChatComponent,
  refOnly,
  toChatComponentManifest,
  type ChatPropsOf,
} from '../../../dist/index.js';
import { bindChatComponent, type ChatComponentProps } from '../../../dist/react/index.js';

export const orderSummary = defineChatComponent({
  id: 'OrderSummary',
  schemaVersion: 1,
  description: 'One order with its total and status.',
  props: z.object({
    title: z.string().describe('Heading'),
    total: bindable(z.number()),
    status: z.enum(['open', 'paid', 'shipped']).optional(),
    customerId: refOnly(z.string()),
  }),
  text: { label: 'title', value: 'total' },
});

export const orderTable = defineChatComponent({
  id: 'OrderTable',
  schemaVersion: 2,
  description: 'Orders as rows.',
  whenToUse: 'More than three orders.',
  props: z.object({
    title: z.string(),
    rows: refOnly(),
    columns: z.array(z.object({ label: z.string(), cell: chatElementId() })),
    meta: z.record(z.string(), bindable(z.string())).optional(),
  }),
  itemScope: { rowsProp: 'rows', cellsProp: 'columns' },
  text: { label: 'title', rows: 'rows', columns: 'columns' },
});

export const manifest = toChatComponentManifest([orderSummary, orderTable]);

// The definition keeps the app's own schema type, and the props type is inferred from it.
export const title: string | undefined = orderSummary.props.shape.title.description;
export const props: ChatPropsOf<typeof orderSummary.props> = { title: 'A', total: 3, customerId: 'c1' };
// @ts-expect-error total is a number
export const wrong: ChatPropsOf<typeof orderSummary.props> = { title: 'A', total: 'three', customerId: 'c1' };

// A browser binding infers the same props type.
export const binding = bindChatComponent(orderSummary, ({ props: bound }: ChatComponentProps<typeof orderSummary.props>) => {
  const total: number = bound.total;
  return total > 0 ? null : null;
});

// zod 3 classic schemas are refused by the types already (and at runtime with a hint to 'zod/v4').
// @ts-expect-error a zod 3 classic schema is no zod 4 schema
export const classic = (): unknown => bindable(z3.string());
