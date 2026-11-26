import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { bindable, defineChatComponent, type ChatPropsOf } from '../../../chat-views/define.js';
import { bindChatComponent, type ChatComponentProps } from '../registry.js';

// The props schemas are typed structurally (zod 4 or `zod/v4` of zod 3.25); the props type stays inferred.
const invoice = defineChatComponent({
  id: 'Invoice',
  schemaVersion: 1,
  description: 'x',
  props: z.object({ customer: bindable(z.string()), total: z.number(), note: z.string().optional() }),
  text: { label: 'customer' },
});
type Expected = { customer: string; total: number; note?: string | undefined };

describe('chat component props types', () => {
  it('infers the props from the schema, the shape (zod 4) and bindChatComponent', () => {
    expectTypeOf<ChatPropsOf<typeof invoice.props>>().toEqualTypeOf<Expected>();
    expectTypeOf<ChatComponentProps<typeof invoice.props>['props']>().toEqualTypeOf<Expected>();
    expectTypeOf<ChatComponentProps<typeof invoice.props.shape>['props']>().toEqualTypeOf<Expected>();
    function ByShape({ props }: ChatComponentProps<typeof invoice.props.shape>) {
      return <b>{props.customer}</b>;
    }
    bindChatComponent(invoice, ByShape);
    bindChatComponent(invoice, ({ props }) => {
      expectTypeOf(props).toEqualTypeOf<Expected>();
      return null;
    });
    // @ts-expect-error total is a number
    bindChatComponent(invoice, ({ props }: { props: { total: string } }) => <b>{props.total}</b>);
  });
});
