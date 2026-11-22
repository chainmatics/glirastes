'use client';

import { useEffect, useRef, type RefObject } from 'react';

const OTHER_MODAL = '[role="alertdialog"], [aria-modal="true"]';
const FOCUSABLE = 'button, [href], input, select, textarea, [contenteditable="true"], [tabindex]';

/** Whether an element is shown and usable: not hidden, not inert, not `display: none` on the way up. */
function isShown(element: Element): boolean {
  if (element.closest('[hidden],[inert]')) return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(element);
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return getComputedStyle(element).visibility !== 'hidden';
}

/**
 * Another modal (e.g. a portaled `ConfirmDialog`) outside the surface owns
 * the keyboard. Hidden or inert ones (a consent manager's closed preference
 * center, anything behind the surface) do not count.
 */
function otherModalOpen(surface: HTMLElement): boolean {
  return Array.from(document.querySelectorAll(OTHER_MODAL))
    .some(element => !surface.contains(element) && !element.contains(surface) && isShown(element));
}

/**
 * Focusable elements inside `surface`. jsdom has no layout, so visibility
 * is read from `hidden` / `inert` ancestors rather than client rects.
 */
export function focusableIn(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element =>
    !(element as HTMLButtonElement).disabled
    && element.getAttribute('tabindex') !== '-1'
    && !element.closest('[hidden],[inert]'));
}

/**
 * While `active`: locks body scroll, marks every sibling on the path from
 * `ref` up to <body> inert (restoring each element's own previous value
 * afterwards), keeps Tab inside `ref`, and calls `onEscape` for an Escape
 * nobody else consumed. Elements added to <body> later (portaled dialogs)
 * and elements marked `data-cm-keep-interactive` are left alone.
 */
export function useModalSurface(ref: RefObject<HTMLElement | null>, options: { active: boolean; onEscape(): void }): void {
  const { active } = options;
  const onEscape = useRef(options.onEscape);
  onEscape.current = options.onEscape;

  useEffect(() => {
    const surface = ref.current;
    if (!active || !surface || typeof document === 'undefined') return;

    // Only elements that were not inert before are touched, so they are the only ones restored.
    const madeInert: HTMLElement[] = [];
    for (let node: HTMLElement = surface; node !== document.body && node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert')) continue;
        // The app keeps toasters or its own portal roots usable over full screen.
        if (sibling.hasAttribute('data-cm-keep-interactive')) continue;
        sibling.setAttribute('inert', '');
        madeInert.push(sibling);
      }
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented || event.isComposing || otherModalOpen(surface)) return;
        event.preventDefault();
        onEscape.current();
        return;
      }
      if (event.key !== 'Tab' || event.defaultPrevented || otherModalOpen(surface)) return;
      const focusables = focusableIn(surface);
      if (focusables.length === 0) { event.preventDefault(); return; }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      const inside = current instanceof HTMLElement && focusables.includes(current);
      if (!inside) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const element of madeInert) element.removeAttribute('inert');
      document.body.style.overflow = overflow;
    };
  }, [active, ref]);
}
