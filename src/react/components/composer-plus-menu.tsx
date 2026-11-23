import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useComposerContext } from '../provider/composer-context.js';
import { sourceSearchOf } from '../completions/completion-search.js';
import type {
  ChatComposerInputControls,
  ComposerPlusMenuConfig,
  ComposerToolbarItem,
  MentionResult,
} from '../types.js';
import type { ResolvedChatTrigger } from '../completions/triggers.js';

const TRIGGER_PREFIX = 'trigger:';
const DEFAULT_SOURCE_LIMIT = 8;

const warned = new Set<string>();

// Static text only: the ids come from the app's config (see sensitive-diagnostics test).
function warnOnce(id: string, kind: 'unknown' | 'trigger' | 'render') {
  const key = `${kind}\u0000${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  if (kind === 'trigger') {
    console.warn('[glirastes] composer.plusMenu: a trigger:<char> id names no trigger of this composer; it was skipped.');
  } else if (kind === 'render') {
    console.warn('[glirastes] composer.plusMenu: an item with render cannot be a menu row; it was skipped.');
  } else {
    console.warn('[glirastes] composer.plusMenu: an id is neither attach, a trigger:<char> nor a key of composer.items; it was skipped.');
  }
}

/** Where focus goes after a row ran: the editor (it opens or fills the editor) or the "+" button. */
type FocusTarget = 'editor' | 'button';

interface MenuRow {
  key: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  focus: FocusTarget;
  run: () => void;
}

export interface ComposerPlusMenuProps {
  config: ComposerPlusMenuConfig | undefined;
  items: Readonly<Record<string, ComposerToolbarItem>> | undefined;
  controls: ChatComposerInputControls;
  /** Trigger chars of the editor; undefined when the input has no completion. */
  triggers?: ReadonlyArray<ResolvedChatTrigger>;
  /** Applies a picked entry in the editor; undefined without completion. */
  pickCompletion?: (item: MentionResult, options: { trigger: string }) => void;
  /** The hidden file input, when the `attach` toolbar item does not render it. */
  attachInput?: ReactNode;
}

/** The `plus` toolbar item: a "+" button with a menu of composer actions. */
export function ComposerPlusMenu({ config, items, controls, triggers, pickCompletion, attachInput }: ComposerPlusMenuProps) {
  const { locale, completionSearch, composer } = useComposerContext();
  const renderIcon = composer?.renderIcon;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [sourceItems, setSourceItems] = useState<ReadonlyArray<MentionResult>>([]);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const sectionId = useId();

  const source = config?.source;
  const canPick = Boolean(triggers && pickCompletion && completionSearch);
  const sourceTrigger = source && canPick && triggers!.some((entry) => entry.char === source.trigger)
    ? source.trigger
    : undefined;

  const close = useCallback((focus: FocusTarget | null) => {
    setOpen(false);
    if (focus === 'button') buttonRef.current?.focus();
    else if (focus === 'editor') controls.focus();
  }, [controls]);

  const rows: MenuRow[] = [];
  const ids = config?.items ?? ['attach', ...(triggers ?? []).map((entry) => `${TRIGGER_PREFIX}${entry.char}`)];
  for (const id of ids) {
    const item = items && Object.prototype.hasOwnProperty.call(items, id) ? items[id] : undefined;
    if (item) {
      if (item.render) {
        warnOnce(id, 'render');
        continue;
      }
      const hidden = typeof item.hidden === 'function' ? item.hidden(controls) : item.hidden;
      if (hidden) continue;
      rows.push({
        key: `item:${id}`,
        label: item.label,
        icon: item.icon,
        ...(item.description ? { description: item.description } : {}),
        focus: 'button',
        run: () => item.onSelect?.(controls),
      });
    } else if (id === 'attach') {
      if (controls.attachmentsEnabled) {
        rows.push({ key: 'attach', label: locale.plusMenuAttachLabel ?? 'Attach file', focus: 'button', run: controls.openFilePicker });
      }
    } else if (id.startsWith(TRIGGER_PREFIX)) {
      // Without completion (the plain input) there is nothing to open.
      if (!triggers) continue;
      const char = id.slice(TRIGGER_PREFIX.length);
      const trigger = triggers.find((entry) => entry.char === char);
      if (!trigger) {
        warnOnce(id, 'trigger');
        continue;
      }
      rows.push({
        key: id,
        label: trigger.label ?? trigger.char,
        icon: trigger.icon,
        ...(trigger.description ? { description: trigger.description } : {}),
        focus: 'editor',
        run: () => controls.openCompletion({ trigger: trigger.char }),
      });
    } else {
      warnOnce(id, 'unknown');
    }
  }
  const staticCount = rows.length;
  if (sourceTrigger) {
    for (const result of sourceItems) {
      const icon = result.icon && renderIcon ? renderIcon(result.icon, { type: result.type, trigger: sourceTrigger }) : undefined;
      rows.push({
        key: `source:${result.key ?? `${result.type}:${result.id}`}`,
        label: result.label,
        ...(icon !== undefined && icon !== null ? { icon } : {}),
        ...(result.description ? { description: result.description } : {}),
        focus: 'editor',
        run: () => pickCompletion!(result, { trigger: sourceTrigger }),
      });
    }
  }

  // The source section is searched once per opening, with an empty query.
  const sourceKey = source?.source === undefined ? '' : JSON.stringify(source.source);
  const limit = source?.limit;
  useEffect(() => {
    if (!open || !sourceTrigger || !completionSearch) return;
    let current = true;
    const filter = source?.source;
    // `completionSearch` is the editor's instance too: this search and one of the editor abort each
    // other. Harmless: the press outside the editor that opens this menu closes the editor's list first.
    const max = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_SOURCE_LIMIT;
    // Narrowed through the internal source search; a search without it lists all entries of the trigger.
    const narrowed = filter === undefined ? undefined : sourceSearchOf(completionSearch);
    (narrowed ? narrowed('', sourceTrigger, filter) : completionSearch('', sourceTrigger))
      .then((results) => { if (current) setSourceItems(results.slice(0, max)); })
      .catch(() => { if (current) setSourceItems([]); });
    return () => {
      current = false;
      setSourceItems([]);
    };
    // `sourceKey` stands for `source.source`, which apps may pass inline.
  }, [open, sourceTrigger, sourceKey, limit, completionSearch]);

  // An outside press closes the menu and leaves focus where it lands.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper && !event.composedPath().includes(wrapper)) setOpen(false);
    };
    const doc = wrapperRef.current?.ownerDocument ?? document;
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const rowCount = rows.length;
  const index = rowCount === 0 ? -1 : Math.min(active, rowCount - 1);
  // Without rows (e.g. a source still loading or empty) no empty menu box is shown.
  const menuShown = open && rowCount > 0;

  // A locked composer disables the button: the menu closes, so the focus never goes back to it.
  // With `queue.enabled` the composer stays open while a turn streams, and so does the menu.
  useEffect(() => {
    if (!controls.canCompose) setOpen(false);
  }, [controls.canCompose]);
  useEffect(() => {
    if (open && index >= 0) rowRefs.current[index]?.focus();
  }, [open, index]);

  const openMenu = (at: 'first' | 'last') => {
    setActive(at === 'first' ? 0 : Math.max(rowCount - 1, 0));
    setOpen(true);
  };

  const choose = (row: MenuRow) => {
    // A row chosen in the same tick the composer locked does nothing.
    if (!controls.canCompose) {
      close(null);
      return;
    }
    close(row.focus);
    row.run();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (rowCount > 0) setActive((index + 1) % rowCount);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (rowCount > 0) setActive((index - 1 + rowCount) % rowCount);
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(Math.max(rowCount - 1, 0));
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close('button');
        return;
      case 'Tab':
        // From the button, so Tab moves on from where the menu was.
        close('button');
        return;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const row = rows[index];
        if (row) choose(row);
        return;
      }
    }
  };

  const label = locale.plusMenuButtonLabel ?? 'More actions';
  const renderRow = (row: MenuRow, position: number) => {
    // With a description the name is the label alone; the description describes the row.
    const labelId = row.description ? `${menuId}-label-${position}` : undefined;
    const descriptionId = row.description ? `${menuId}-description-${position}` : undefined;
    return (
      <button
        key={row.key}
        ref={(element) => { rowRefs.current[position] = element; }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-element="plus-menu-item"
        {...(labelId ? { 'aria-labelledby': labelId, 'aria-describedby': descriptionId } : {})}
        onClick={() => choose(row)}
        onMouseMove={() => { if (position !== index) setActive(position); }}
      >
        {row.icon !== undefined && row.icon !== null && <span data-element="plus-menu-icon" aria-hidden="true">{row.icon}</span>}
        <span data-element="plus-menu-label" {...(labelId ? { id: labelId } : {})}>{row.label}</span>
        {row.description && <span data-element="plus-menu-description" id={descriptionId}>{row.description}</span>}
      </button>
    );
  };
  rowRefs.current.length = rowCount;

  return (
    <span ref={wrapperRef} data-component="composer-plus-menu">
      {attachInput}
      <button
        ref={buttonRef}
        type="button"
        data-component="composer-plus-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        // The menu element, not the open state: while it has no rows nothing shows.
        aria-expanded={menuShown}
        {...(menuShown ? { 'aria-controls': menuId } : {})}
        disabled={!controls.canCompose}
        onClick={() => (open ? close(null) : openMenu('first'))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
          } else if (event.key === 'Escape' && open) {
            // The focus stays on the button while the menu has no rows yet.
            event.preventDefault();
            event.stopPropagation();
            close(null);
          }
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
      {menuShown && (
        <div id={menuId} role="menu" aria-label={label} data-element="plus-menu" onKeyDown={onMenuKeyDown}>
          {rows.slice(0, staticCount).map((row, position) => renderRow(row, position))}
          {rowCount > staticCount && (
            <div role="group" data-element="plus-menu-section" {...(source?.label ? { 'aria-labelledby': sectionId } : {})}>
              {source?.label && <div id={sectionId} role="presentation" data-element="plus-menu-heading">{source.label}</div>}
              {rows.slice(staticCount).map((row, offset) => renderRow(row, staticCount + offset))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
