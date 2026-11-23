// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell } from '../assistant-shell.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';

let narrow = false;
let listeners = new Set<() => void>();
const innerWidth = window.innerWidth;
beforeEach(() => {
  narrow = false;
  listeners = new Set();
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('max-width: 899.98px') ? narrow : false; },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function chat(): ChatContextValue {
  return {
    sessionsSupported: true,
    sessions: [{ id: 'a', title: 'Open orders' }, { id: 'b', title: 'Customers' }],
    activeSessionId: 'a',
    isSessionsLoading: false,
    isLoading: false,
    isSessionChangeBlocked: false,
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => null),
    removeSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    clear: vi.fn(),
    locale: DEFAULT_LOCALE,
  } as unknown as ChatContextValue;
}
function Go() {
  const ui = useAssistantLayout();
  return <>
    {(['sidebar', 'floating', 'fullscreen'] as const).map(mode => <button key={mode} type="button" onClick={() => ui.setMode(mode)}>to {mode}</button>)}
    <button type="button" onClick={() => ui.setCollapsed(true)}>collapse it</button>
  </>;
}
type ShellProps = Partial<React.ComponentProps<typeof AssistantShell>>;
const tree = (props: ShellProps) => <ChatContext.Provider value={chat()}><AssistantLayoutProvider storageKey={null}>
  <Go />
  <div><main data-assistant-main>Page</main>
    <AssistantShell modes={['sidebar', 'floating', 'fullscreen']} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
</AssistantLayoutProvider></ChatContext.Provider>;
async function mount(props: ShellProps = {}) {
  const view = render(tree(props));
  await frame();
  return { rerender: async (next: ShellProps) => { view.rerender(tree(next)); await frame(); } };
}
const go = async (mode: AssistantLayoutMode) => { act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); }); await frame(); };
/** The row width the shell measures (jsdom has no layout, so it falls back to the window width). */
const rowWidth = async (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
  await frame();
};
const breakpoint = async (isNarrow: boolean) => { narrow = isNarrow; act(() => { listeners.forEach(listener => listener()); }); await frame(); };
const shell = () => document.querySelector<HTMLElement>('[data-component="assistant-shell"]')!;
const column = () => document.querySelector<HTMLElement>('[data-element="history"]')!;
const flexOf = (element: HTMLElement) => ({ grow: element.style.flexGrow, shrink: element.style.flexShrink, basis: element.style.flexBasis });

describe('flex styles of the shell', () => {
  it('no React style warning when the docked shell starts and stops filling the row, or at the 900 px breakpoint', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    await go('sidebar');
    await rowWidth(600);
    await rowWidth(1200);
    await rowWidth(600);
    await go('fullscreen');
    await breakpoint(true);
    await breakpoint(false);
    await go('sidebar');
    await rowWidth(1200);
    const styleWarnings = error.mock.calls.filter(call => /style property|shorthand|conflicting property/i.test(String(call[0])));
    expect(styleWarnings).toEqual([]);
  });

  it('flex values per state are the base values', async () => {
    await mount();
    await go('sidebar');
    // Recorded on the base code (0.24.1), except where marked.
    expect(flexOf(shell())).toEqual({ grow: '', shrink: '0', basis: '' });
    await rowWidth(600);
    expect(flexOf(shell())).toEqual({ grow: '1', shrink: '1', basis: '0%' });
    // Declared fix: the base lost `flex-shrink: 0` here (shrink '') after filling the row once.
    await rowWidth(1200);
    expect(flexOf(shell())).toEqual({ grow: '', shrink: '0', basis: '' });
    await go('fullscreen');
    expect(flexOf(shell())).toEqual({ grow: '', shrink: '', basis: '' });
    expect(flexOf(column())).toEqual({ grow: '0', shrink: '0', basis: '260px' });
    await breakpoint(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(flexOf(column())).toEqual({ grow: '', shrink: '', basis: '' });
  });
});

/**
 * Each step changes one thing; after each the shell's flex longhands and the React style
 * warnings so far are read. `BASE` holds what the base code (0.24.1) gave, recorded there.
 */
type Step = ['row', number] | ['mode', AssistantLayoutMode] | ['collapse'] | ['narrowWidth', number];
const flexState = () => {
  const { grow, shrink, basis } = flexOf(shell());
  return `${grow || '-'}/${shrink || '-'}/${basis || '-'}`;
};
async function runSteps(props: ShellProps, steps: Step[]) {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const view = await mount(props);
  await go('sidebar');
  await rowWidth(1200);
  const states = [flexState()];
  let current = props;
  for (const step of steps) {
    if (step[0] === 'row') await rowWidth(step[1]);
    else if (step[0] === 'mode') await go(step[1]);
    else if (step[0] === 'collapse') { act(() => { fireEvent.click(screen.getByText('collapse it')); }); await frame(); }
    else { current = { ...current, narrowWidth: step[1] }; await view.rerender(current); }
    states.push(flexState());
  }
  const warnings = error.mock.calls
    .filter(call => /conflicting property/.test(String(call[0])))
    .map(call => `${call[1]} ${call[2]} vs ${call[3]}`);
  error.mockRestore();
  return { states, warnings };
}
const SEQUENCES: Record<string, Step[]> = {
  'wide → narrow → wide': [['row', 600], ['row', 1200]],
  'narrow → floating': [['row', 600], ['mode', 'floating']],
  'narrow → full screen': [['row', 600], ['mode', 'fullscreen']],
  'narrow → collapsed rail': [['row', 600], ['collapse']],
  'narrow → narrowWidth lowered at runtime': [['row', 600], ['narrowWidth', 500]],
};
const STYLES: Record<string, ShellProps['style']> = {
  'no app style': undefined,
  "app flex '0 0 400px'": { flex: '0 0 400px' },
  'app flex 1': { flex: 1 },
  'app flexGrow 2, flexBasis 300px': { flexGrow: 2, flexBasis: '300px' },
};

/** Recorded on the base code (0.24.1): flex grow/shrink/basis after each step, and the React style warnings. */
const BASE: Record<string, { states: string[]; warnings: string[] }> = {
  "app flex '0 0 400px': narrow \u2192 collapsed rail": { states: ["0/0/400px", "1/1/0%", "0/0/400px"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flex '0 0 400px': narrow \u2192 floating": { states: ["0/0/400px", "1/1/0%", "0/0/400px"], warnings: ["Updating flex vs flexShrink"] },
  "app flex '0 0 400px': narrow \u2192 full screen": { states: ["0/0/400px", "1/1/0%", "0/0/400px"], warnings: ["Updating flex vs flexShrink"] },
  "app flex '0 0 400px': narrow \u2192 narrowWidth lowered at runtime": { states: ["0/0/400px", "1/1/0%", "0/0/400px"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flex '0 0 400px': wide \u2192 narrow \u2192 wide": { states: ["0/0/400px", "1/1/0%", "0/0/400px"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flex 1: narrow \u2192 collapsed rail": { states: ["1/0/0%", "1/1/0%", "1/1/0%"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flex 1: narrow \u2192 floating": { states: ["1/0/0%", "1/1/0%", "1/1/0%"], warnings: ["Updating flex vs flexShrink"] },
  "app flex 1: narrow \u2192 full screen": { states: ["1/0/0%", "1/1/0%", "1/1/0%"], warnings: ["Updating flex vs flexShrink"] },
  "app flex 1: narrow \u2192 narrowWidth lowered at runtime": { states: ["1/0/0%", "1/1/0%", "1/1/0%"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flex 1: wide \u2192 narrow \u2192 wide": { states: ["1/0/0%", "1/1/0%", "1/1/0%"], warnings: ["Updating flex vs flexShrink", "Updating flex vs flexShrink"] },
  "app flexGrow 2, flexBasis 300px: narrow \u2192 collapsed rail": { states: ["2/0/300px", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexBasis", "Removing flex vs flexGrow", "Removing flex vs flexShrink"] },
  "app flexGrow 2, flexBasis 300px: narrow \u2192 floating": { states: ["2/0/300px", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexBasis", "Removing flex vs flexGrow"] },
  "app flexGrow 2, flexBasis 300px: narrow \u2192 full screen": { states: ["2/0/300px", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexBasis", "Removing flex vs flexGrow"] },
  "app flexGrow 2, flexBasis 300px: narrow \u2192 narrowWidth lowered at runtime": { states: ["2/0/300px", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexBasis", "Removing flex vs flexGrow", "Removing flex vs flexShrink"] },
  "app flexGrow 2, flexBasis 300px: wide \u2192 narrow \u2192 wide": { states: ["2/0/300px", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexBasis", "Removing flex vs flexGrow", "Removing flex vs flexShrink"] },
  "no app style: narrow \u2192 collapsed rail": { states: ["-/0/-", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexShrink"] },
  "no app style: narrow \u2192 floating": { states: ["-/0/-", "1/1/0%", "-/-/-"], warnings: [] },
  "no app style: narrow \u2192 full screen": { states: ["-/0/-", "1/1/0%", "-/-/-"], warnings: [] },
  "no app style: narrow \u2192 narrowWidth lowered at runtime": { states: ["-/0/-", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexShrink"] },
  "no app style: wide \u2192 narrow \u2192 wide": { states: ["-/0/-", "1/1/0%", "-/-/-"], warnings: ["Removing flex vs flexShrink"] },
};

/**
 * Declared differences from the base, only for an app style without the `flex` shorthand: the
 * docked shell keeps `flex-shrink: 0` (and the app's own grow and basis) after it stopped filling
 * the row, and React no longer warns. With an app `flex` shorthand every value and warning is
 * the base's.
 */
const KEPT = { warnings: [] as string[] };
const DECLARED: Record<string, { states: string[]; warnings: string[] }> = {
  'no app style: wide → narrow → wide': { states: ['-/0/-', '1/1/0%', '-/0/-'], ...KEPT },
  'no app style: narrow → collapsed rail': { states: ['-/0/-', '1/1/0%', '-/0/-'], ...KEPT },
  'no app style: narrow → narrowWidth lowered at runtime': { states: ['-/0/-', '1/1/0%', '-/0/-'], ...KEPT },
  'app flexGrow 2, flexBasis 300px: wide → narrow → wide': { states: ['2/0/300px', '1/1/0%', '2/0/300px'], ...KEPT },
  'app flexGrow 2, flexBasis 300px: narrow → collapsed rail': { states: ['2/0/300px', '1/1/0%', '2/0/300px'], ...KEPT },
  'app flexGrow 2, flexBasis 300px: narrow → narrowWidth lowered at runtime': { states: ['2/0/300px', '1/1/0%', '2/0/300px'], ...KEPT },
  'app flexGrow 2, flexBasis 300px: narrow → floating': { states: ['2/0/300px', '1/1/0%', '2/-/300px'], ...KEPT },
  'app flexGrow 2, flexBasis 300px: narrow → full screen': { states: ['2/0/300px', '1/1/0%', '2/-/300px'], ...KEPT },
};

describe('flex transitions per app style', () => {
  for (const [styleName, style] of Object.entries(STYLES)) {
    for (const [sequence, steps] of Object.entries(SEQUENCES)) {
      it(`${styleName}: ${sequence}`, async () => {
        const key = `${styleName}: ${sequence}`;
        expect(await runSteps(style ? { style } : {}, steps)).toEqual(DECLARED[key] ?? BASE[key]);
      });
    }
  }
});

describe('drawer state attributes (stable)', () => {
  it('wide column, hidden column, closed and open drawer', async () => {
    await mount();
    await go('fullscreen');
    const toggle = () => document.querySelector<HTMLElement>('[data-action="history"]')!;
    const backdrop = () => document.querySelector('[data-element="history-backdrop"]');
    const state = () => ({
      drawer: column().getAttribute('data-drawer'),
      hidden: column().hasAttribute('hidden'),
      inert: column().hasAttribute('inert'),
      role: column().getAttribute('role'),
      modal: column().getAttribute('aria-modal'),
      expanded: toggle().getAttribute('aria-expanded'),
      backdrop: backdrop() !== null,
      frameInert: document.querySelector('[data-element="frame"]')!.hasAttribute('inert'),
    });
    expect(state()).toEqual({ drawer: null, hidden: false, inert: false, role: null, modal: null, expanded: 'true', backdrop: false, frameInert: false });
    fireEvent.click(toggle());
    expect(state()).toEqual({ drawer: null, hidden: true, inert: true, role: null, modal: null, expanded: 'false', backdrop: false, frameInert: false });
    await breakpoint(true);
    expect(state()).toEqual({ drawer: 'true', hidden: true, inert: true, role: null, modal: null, expanded: 'false', backdrop: false, frameInert: false });
    fireEvent.click(toggle());
    expect(state()).toEqual({ drawer: 'true', hidden: false, inert: false, role: 'dialog', modal: 'true', expanded: 'true', backdrop: true, frameInert: true });
  });

  it('classNames.historyBackdrop goes on the backdrop; without it the backdrop has no class', async () => {
    narrow = true;
    await mount({ classNames: { historyBackdrop: 'my-backdrop' } });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(document.querySelector('[data-element="history-backdrop"]')!.className).toBe('my-backdrop');
    cleanup();
    await mount();
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(document.querySelector('[data-element="history-backdrop"]')!.hasAttribute('class')).toBe(false);
  });
});
