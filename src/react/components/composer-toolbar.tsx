import { Fragment, type MouseEvent, type ReactNode } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { ComposerPlusMenu } from './composer-plus-menu.js';
import type {
  ChatComposerInputControls,
  ComposerToolbarItem,
  MentionResult,
  ResolvedChatTrigger,
} from '../types.js';

const DEFAULT_START: ReadonlyArray<string> = ['attach'];
const DEFAULT_END: ReadonlyArray<string> = ['mic', 'actions', 'extra', 'send'];
const TRIGGER_PREFIX = 'trigger:';

/** The input's own parts by builtin id; null/undefined when unavailable (e.g. attachments off). */
export type ComposerBuiltinNodes = Readonly<Record<'attach' | 'mic' | 'actions' | 'extra' | 'send', ReactNode>>;

const warned = new Set<string>();

// Static text only: the ids come from the app's config (see sensitive-diagnostics test).
function warnOnce(id: string, kind: 'unknown' | 'trigger') {
  if (warned.has(id)) return;
  warned.add(id);
  if (kind === 'trigger') {
    console.warn('[glirastes] composer.toolbar: a trigger:<char> id names no trigger of this composer; it was skipped.');
  } else {
    console.warn('[glirastes] composer.toolbar: an id is neither a builtin nor a key of composer.items; it was skipped.');
  }
}

function keepFocus(event: MouseEvent) {
  // Keeps the caret in the editor, so the list opens where the user was typing.
  event.preventDefault();
}

function isBuiltin(id: string): id is keyof ComposerBuiltinNodes {
  return id === 'attach' || id === 'mic' || id === 'actions' || id === 'extra' || id === 'send';
}

function renderItem(id: string, item: ComposerToolbarItem, controls: ChatComposerInputControls): ReactNode {
  const hidden = typeof item.hidden === 'function' ? item.hidden(controls) : item.hidden;
  if (hidden) return null;
  if (item.render) return item.render(controls);
  return (
    <button
      type="button"
      data-component="composer-toolbar-item"
      data-item={id}
      aria-label={item.label}
      title={item.label}
      onClick={() => item.onSelect?.(controls)}
    >
      {item.icon ?? item.label}
    </button>
  );
}

function renderTrigger(id: string, triggers: ReadonlyArray<ResolvedChatTrigger> | undefined, controls: ChatComposerInputControls): ReactNode {
  // Without completion (the plain input) there is nothing to open.
  if (!triggers) return null;
  const char = id.slice(TRIGGER_PREFIX.length);
  const trigger = triggers.find((entry) => entry.char === char);
  if (!trigger) {
    warnOnce(id, 'trigger');
    return null;
  }
  const label = trigger.label ?? trigger.char;
  return (
    <button
      type="button"
      data-component="composer-trigger-button"
      data-trigger={trigger.char}
      aria-label={label}
      title={label}
      disabled={controls.isLoading}
      onMouseDown={keepFocus}
      onClick={() => controls.openCompletion({ trigger: trigger.char })}
    >
      {trigger.char}
    </button>
  );
}

export interface ComposerToolbarLayoutProps {
  builtins: ComposerBuiltinNodes;
  editor: ReactNode;
  controls: ChatComposerInputControls;
  /** Trigger chars of the editor; undefined when the input has no completion. */
  triggers?: ReadonlyArray<ResolvedChatTrigger>;
  /** The "+" menu applies a listed entry with it; undefined without completion. */
  pickCompletion?: (item: MentionResult, options: { trigger: string }) => void;
  /** The hidden file input of `attach`; the "+" menu renders it when the `attach` item does not. */
  attachInput?: ReactNode;
}

/**
 * The composer row inside the input's form: `composer.toolbar` items around
 * the editor, or `components.ComposerToolbar` when set. Renders no wrapper,
 * so the default layout is the same markup as before the toolbar existed.
 */
export function ComposerToolbarLayout({ builtins, editor, controls, triggers, pickCompletion, attachInput }: ComposerToolbarLayoutProps) {
  const { composer, components } = useChatContext();
  const items = composer?.items;
  const hasItem = (id: string) => !!items && Object.prototype.hasOwnProperty.call(items, id) && !!items[id];
  const startIds = composer?.toolbar?.start ?? DEFAULT_START;
  const endIds = composer?.toolbar?.end ?? DEFAULT_END;
  // The attach builtin brings the file input; without it the "+" menu does.
  const attachBuiltinShown = !hasItem('attach') && (startIds.includes('attach') || endIds.includes('attach'));

  const build = (ids: ReadonlyArray<string>): ReactNode[] => {
    const nodes: ReactNode[] = [];
    for (const id of ids) {
      let node: ReactNode;
      const item = items && Object.prototype.hasOwnProperty.call(items, id) ? items[id] : undefined;
      if (item) node = renderItem(id, item, controls);
      else if (isBuiltin(id)) node = builtins[id];
      else if (id === 'plus') {
        node = (
          <ComposerPlusMenu
            config={composer?.plusMenu}
            items={items}
            controls={controls}
            triggers={triggers}
            pickCompletion={pickCompletion}
            attachInput={attachBuiltinShown ? undefined : attachInput}
          />
        );
      }
      else if (id.startsWith(TRIGGER_PREFIX)) node = renderTrigger(id, triggers, controls);
      else warnOnce(id, 'unknown');
      if (node === null || node === undefined || node === false) continue;
      nodes.push(<Fragment key={id}>{node}</Fragment>);
    }
    return nodes;
  };

  const start = build(startIds);
  const end = build(endIds);
  const Toolbar = components.ComposerToolbar;
  if (Toolbar) return <Toolbar start={start} end={end} editor={editor} controls={controls} />;
  return <>{start}{editor}{end}</>;
}
