import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
  ChatViewCapabilities,
} from '../../contracts/chat-view.js';
import { toChatComponentManifest, type ChatComponentDefinition } from '../../chat-views/define.js';
import { validateResolvedChatElementProps } from '../../chat-views/validate.js';

/** What a view element may do: both targets are existing chat paths. */
export interface ChatViewDispatch {
  /** Sends `text` as the user's next message. */
  prompt(text: string): void;
  /** Runs a registered client action through the UI action bus. */
  uiAction(id: string, args?: Record<string, unknown>): void;
}

/** Props of an app's (or the SDK's) component for one chat view element. */
export interface ChatComponentProps<P extends z.ZodRawShape = z.ZodRawShape> {
  /** The element's resolved props, checked against its schema version. */
  props: z.infer<z.ZodObject<P>>;
  /** The rendered child elements. */
  children?: ReactNode;
  /** The value is a statement of the assistant; the SDK marks it next to the element. */
  said?: boolean;
  /** Rows of an item-scope element (Table), keyed per cell element id. */
  rows?: ReadonlyArray<Record<string, unknown>>;
  /** Renders the cell element `cellId` with the props of row `rowIndex`. */
  renderCell(rowIndex: number, cellId: string): ReactNode;
  /** BCP 47 language for numbers, money and dates. */
  locale: string;
  dispatch: ChatViewDispatch;
}

/** One catalog component bound to the component that renders it. */
export interface ChatComponentBinding {
  readonly definition: ChatComponentDefinition;
  // Bindings are invariant in their props; the registry erases them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly component: ComponentType<ChatComponentProps<any>>;
}

export function bindChatComponent<P extends z.ZodRawShape>(
  definition: ChatComponentDefinition<P>,
  component: ComponentType<ChatComponentProps<P>>,
): ChatComponentBinding {
  return {
    definition: definition as unknown as ChatComponentDefinition,
    component: component as ComponentType<ChatComponentProps<z.ZodRawShape>>,
  };
}

export interface ResolvedChatComponent {
  binding: ChatComponentBinding;
  entry: ChatComponentManifestEntry;
}

export interface ChatViewRegistry {
  /** Manifest of the bound components (validation and the text fallback). */
  readonly manifest: ChatComponentManifest;
  /**
   * The binding for an element: the highest bound `schemaVersion` of `type`
   * up to the element's own whose schema accepts the props; undefined when
   * none does (the element then renders as text).
   */
  resolve(type: string, schemaVersion: number, props: Record<string, unknown>): ResolvedChatComponent | undefined;
  /** What the browser can render, for the request (`chatViews.components`). */
  capabilities(): ChatViewCapabilities['components'];
}

const keyOf = (definition: { id: string; schemaVersion: number }) => `${definition.id}@${definition.schemaVersion}`;

/**
 * Bindings merged by `id@schemaVersion`: a later binding replaces an earlier
 * one with the same key (the app's over the starter bindings).
 */
export function mergeChatComponentBindings(
  ...lists: ReadonlyArray<ReadonlyArray<ChatComponentBinding>>
): ChatComponentBinding[] {
  const merged = new Map<string, ChatComponentBinding>();
  for (const list of lists) {
    for (const binding of list) merged.set(keyOf(binding.definition), binding);
  }
  return [...merged.values()];
}

export function createChatViewRegistry(bindings: ReadonlyArray<ChatComponentBinding>): ChatViewRegistry {
  // Throws on a duplicate id@schemaVersion or a props schema outside the JSON Schema subset.
  const manifest = toChatComponentManifest(bindings.map((binding) => binding.definition));
  const byId = new Map<string, ResolvedChatComponent[]>();
  bindings.forEach((binding, index) => {
    const list = byId.get(binding.definition.id) ?? [];
    list.push({ binding, entry: manifest.components[index]! });
    list.sort((left, right) => right.entry.schemaVersion - left.entry.schemaVersion);
    byId.set(binding.definition.id, list);
  });
  const capabilities = manifest.components.map((entry) => ({ id: entry.id, schemaVersion: entry.schemaVersion }));

  return Object.freeze({
    manifest,
    resolve(type: string, schemaVersion: number, props: Record<string, unknown>) {
      for (const candidate of byId.get(type) ?? []) {
        if (candidate.entry.schemaVersion > schemaVersion) continue;
        if (validateResolvedChatElementProps(props, candidate.entry).length === 0) return candidate;
      }
      return undefined;
    },
    capabilities: () => capabilities.map((entry) => ({ ...entry })),
  });
}
