'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { AssistantLayoutMode } from './assistant-layout.js';

export interface AssistantModeMenuTrigger {
  /** Whether the menu is open. */
  expanded: boolean;
  /** Id of the open menu, for `aria-controls`; undefined while closed. */
  controls?: string;
  onClick(): void;
}

export interface AssistantModeMenuProps {
  modes: ReadonlyArray<AssistantLayoutMode>;
  current: AssistantLayoutMode;
  /** Name of the menu. */
  label: string;
  entries: Record<AssistantLayoutMode, { label: string; icon: ReactNode }>;
  renderTrigger(trigger: AssistantModeMenuTrigger): ReactNode;
  onPick(mode: AssistantLayoutMode): void;
}

/**
 * The layout menu of the shell header (sidebar, window, full screen). Not
 * exported: the shell shows it when its `modes` include full screen.
 */
export function AssistantModeMenu({ modes, current, label, entries, renderTrigger, onPick }: AssistantModeMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pending = useRef<'checked' | 'last' | null>(null);
  const id = `assistant-mode-menu-${useId().replace(/:/g, '')}`;

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  const trigger = () => Array.from(wrapper.current?.querySelectorAll<HTMLElement>('button, [tabindex]') ?? [])
    .find(element => !menu.current?.contains(element));
  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger()?.focus(); };
  const show = (focus: 'checked' | 'last') => { pending.current = focus; setOpen(true); };

  // Focus moves into the menu once it is rendered.
  useEffect(() => {
    if (!open || !pending.current) return;
    const list = items();
    const target = pending.current === 'last' ? list[list.length - 1] : list.find(item => item.getAttribute('aria-checked') === 'true') ?? list[0];
    pending.current = null;
    target?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const pick = (mode: AssistantLayoutMode) => {
    if (mode === current) { close(true); return; }
    setOpen(false);
    onPick(mode);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (menu.current?.contains(event.target as Node)) return;
    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); show('checked'); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); show('last'); }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => { event.preventDefault(); list[(to + list.length) % list.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': move(index + 1); break;
      case 'ArrowUp': move(index < 0 ? list.length - 1 : index - 1); break;
      case 'Home': move(0); break;
      case 'End': move(list.length - 1); break;
      case 'Escape':
        // The menu owns this Escape: full screen stays open.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      // Back on the trigger before the browser's Tab runs, so Tab moves on from there.
      case 'Tab': close(true); break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const mode = list[index]?.dataset.mode as AssistantLayoutMode | undefined;
        if (mode) pick(mode);
        break;
      }
    }
  };

  return <div data-element="mode-picker" ref={wrapper} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
    onKeyDown={onTriggerKeyDown}>
    {renderTrigger({ expanded: open, controls: open ? id : undefined, onClick: () => open ? close(false) : show('checked') })}
    {open && <div data-element="mode-menu" role="menu" id={id} aria-label={label} ref={menu} onKeyDown={onMenuKeyDown}
      style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10, display: 'flex', flexDirection: 'column' }}>
      {modes.map(mode => <button key={mode} type="button" role="menuitemradio" tabIndex={-1}
        aria-checked={mode === current} data-mode={mode} onClick={() => pick(mode)}>
        <span data-element="icon" aria-hidden="true">{entries[mode].icon}</span>{entries[mode].label}
      </button>)}
    </div>}
  </div>;
}
