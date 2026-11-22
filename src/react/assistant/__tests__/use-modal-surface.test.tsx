// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useModalSurface } from '../use-modal-surface.js';

afterEach(() => { cleanup(); document.body.innerHTML = ''; document.body.removeAttribute('style'); });

function Surface({ active, onEscape = () => {}, children }: { active: boolean; onEscape?: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useModalSurface(ref, { active, onEscape });
  return <section ref={ref} data-testid="surface">{children ?? <>
    <button>First</button><button hidden>Hidden</button><div ref={el => { el?.setAttribute('inert', ''); }}><button>Inert</button></div>
    <button disabled>Disabled</button><button>Last</button>
  </>}</section>;
}

/** <body><header/><div id="root"><main/><section ref/></div><div inert/></body> */
function setup(active: boolean, onEscape?: () => void) {
  const header = document.body.appendChild(document.createElement('header'));
  const root = document.body.appendChild(document.createElement('div'));
  const wasInert = document.body.appendChild(document.createElement('div'));
  wasInert.setAttribute('inert', '');
  wasInert.dataset.testid = 'was-inert';
  document.body.style.overflow = 'scroll';
  const ui = (on: boolean) => <><main data-testid="main" /><Surface active={on} onEscape={onEscape} /></>;
  const view = render(ui(active), { container: root });
  return { header, root, wasInert, view, rerender: (on: boolean) => view.rerender(ui(on)) };
}

describe('useModalSurface', () => {
  it('marks the page inert and restores exactly', () => {
    const { header, wasInert, rerender } = setup(true);
    const main = screen.getByTestId('main');
    expect(header.hasAttribute('inert')).toBe(true);
    expect(main.hasAttribute('inert')).toBe(true);
    expect(wasInert.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('surface').hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(false);
    expect(header.hasAttribute('inert')).toBe(false);
    expect(main.hasAttribute('inert')).toBe(false);
    expect(wasInert.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('unmount while active restores everything', () => {
    const { header, view } = setup(true);
    view.unmount();
    expect(header.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('a dialog added later is not inert', () => {
    setup(true);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    expect(dialog.hasAttribute('inert')).toBe(false);
  });

  it('Tab wraps inside the surface', () => {
    setup(true);
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('a hidden or inert modal elsewhere on the page does not take Escape or Tab', () => {
    // Consent managers keep a hidden preference center with aria-modal in the DOM.
    const consent = document.body.appendChild(document.createElement('div'));
    consent.setAttribute('role', 'dialog');
    consent.setAttribute('aria-modal', 'true');
    consent.hidden = true;
    const closed = document.body.appendChild(document.createElement('div'));
    closed.style.display = 'none';
    closed.appendChild(document.createElement('div')).setAttribute('aria-modal', 'true');
    // Visible, but in a sibling the surface makes inert.
    const behind = document.body.appendChild(document.createElement('div'));
    behind.appendChild(document.createElement('div')).setAttribute('role', 'alertdialog');
    const onEscape = vi.fn();
    setup(true, onEscape);
    expect(behind.hasAttribute('inert')).toBe(true);
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('escape ownership', () => {
    const onEscape = vi.fn();
    function Owned() {
      const surface = useRef<HTMLElement>(null);
      useModalSurface(surface, { active: true, onEscape });
      return <section ref={surface}>
        <textarea aria-label="Plain" />
        <textarea aria-label="List" onKeyDown={e => { if (e.key === 'Escape') e.preventDefault(); }} />
      </section>;
    }
    render(<Owned />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plain' }), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'List' }), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plain' }), { key: 'Escape', isComposing: true });
    expect(onEscape).toHaveBeenCalledTimes(1);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'alertdialog');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plain' }), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    dialog.remove();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plain' }), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(2);
  });
});
