/**
 * The SDK starter catalog: semantic components (no visual props). Apps may
 * use it as is, extend it, or replace it with their own catalog.
 */
import { z } from 'zod';
import type { ChatComponentManifest } from '../contracts/chat-view.js';
import {
  bindable,
  defineChatComponent,
  refOnly,
  toChatComponentManifest,
  type ChatComponentDefinition,
} from './define.js';
import { chatElementId } from './element-id.js';

const scalar = () => z.union([z.string(), z.number(), z.boolean()]);
const isoDateOrDateTime = () => z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const starterChatComponents: ChatComponentDefinition<z.ZodObject>[] = [
  defineChatComponent({
    id: 'Group',
    schemaVersion: 1,
    description: 'Groups child elements',
    whenToUse: 'arranging several elements',
    props: z.object({ emphasis: z.enum(['none', 'subtle', 'strong']).optional() }),
    children: 'any',
    text: {},
  }),
  defineChatComponent({
    id: 'Card',
    schemaVersion: 1,
    description: 'Titled section with child elements',
    props: z.object({ title: z.string() }),
    children: 'any',
    text: { label: 'title' },
  }),
  defineChatComponent({
    id: 'Text',
    schemaVersion: 1,
    description: 'Short paragraph',
    props: z.object({ text: z.string() }),
    text: { value: 'text' },
  }),
  defineChatComponent({
    id: 'KeyValue',
    schemaVersion: 1,
    description: 'Label/value pairs',
    whenToUse: 'facts of one record',
    props: z.object({
      items: z.array(z.object({ label: z.string(), value: bindable(scalar()) })).max(12),
    }),
    text: { rows: 'items' },
  }),
  defineChatComponent({
    id: 'Table',
    schemaVersion: 1,
    description: 'Rows of a result list; each column renders its cell element per row',
    whenToUse: '4+ like records',
    props: z.object({
      rows: refOnly(z.array(z.record(z.string(), z.unknown()))),
      columns: z.array(z.object({ header: z.string().max(40), cell: chatElementId() })).max(8),
    }),
    itemScope: { rowsProp: 'rows', cellsProp: 'columns' },
    text: { rows: 'rows', columns: 'columns' },
  }),
  defineChatComponent({
    id: 'StatusBadge',
    schemaVersion: 1,
    description: 'Status label',
    props: z.object({
      label: bindable(z.string()),
      tone: z.enum(['neutral', 'success', 'warning', 'danger']),
    }),
    text: { value: 'label' },
  }),
  defineChatComponent({
    id: 'EntityLink',
    schemaVersion: 1,
    description: 'Link to a record of a declared entity type',
    props: z.object({
      entity: z.string(),
      record: refOnly(),
      label: bindable(z.string()),
    }),
    text: { value: 'label' },
  }),
  defineChatComponent({
    id: 'Money',
    schemaVersion: 1,
    description: 'Amount with ISO currency, formatted by the app',
    props: z.object({
      amount: bindable(z.number()),
      currency: bindable(z.string().regex(/^[A-Z]{3}$/)),
    }),
    text: { value: 'amount' },
  }),
  defineChatComponent({
    id: 'DateTime',
    schemaVersion: 1,
    description: 'ISO date or timestamp, formatted by the app',
    props: z.object({
      value: bindable(isoDateOrDateTime()),
      mode: z.enum(['date', 'datetime']),
    }),
    text: { value: 'value' },
  }),
  defineChatComponent({
    id: 'Stat',
    schemaVersion: 1,
    description: 'One key figure',
    whenToUse: 'a total or count; value may use $count/$sum/$said',
    props: z.object({ label: z.string(), value: bindable(z.union([z.number(), z.string()])) }),
    text: { label: 'label', value: 'value' },
  }),
  defineChatComponent({
    id: 'Action',
    schemaVersion: 1,
    description: 'Button with exactly one target: prompt (sends a user message) or uiAction (client action)',
    props: z.object({
      label: z.string().min(1).max(40),
      prompt: z.string().optional(),
      uiAction: z
        .object({
          id: z.string(),
          args: z.record(z.string(), bindable(z.union([scalar(), z.null()]))).optional(),
        })
        .optional(),
    }),
    text: { label: 'label' },
  }),
];

/** Manifest of the starter catalog (used when the app declares no catalog). */
export const starterChatComponentManifest: ChatComponentManifest =
  toChatComponentManifest(starterChatComponents);
