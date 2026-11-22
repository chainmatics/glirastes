// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantLayoutProvider,
  DEFAULT_ASSISTANT_LAYOUT_KEY,
  parseAssistantLayout,
  useAssistantLayout,
  type AssistantLayoutMode,
} from '../assistant-layout.js';

let store = new Map<string, string>();
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
let renders = 0;
function Probe() {
  const ui = useAssistantLayout();
  renders += 1;
  const { open, mode, defaultMode, collapsed } = ui;
  const go = (mode: AssistantLayoutMode) => () => ui.setMode(mode);
  return <>
    <output data-testid="state">{JSON.stringify({ open, mode, defaultMode, collapsed })}</output>
    <button onClick={go('sidebar')}>sidebar</button>
    <button onClick={go('floating')}>floating</button>
    <button onClick={go('fullscreen')}>fullscreen</button>
    <button onClick={ui.restoreMode}>restore</button>
    <button onClick={ui.openChat}>open</button>
    <button onClick={ui.closeChat}>close</button>
    <button onClick={() => ui.setDefaultMode('fullscreen')}>default fullscreen</button>
  </>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('fullscreen layout mode', () => {
  it('full screen opens the assistant and keeps the layout it came from', () => {
    render(<AssistantLayoutProvider storageKey={null}><Probe /></AssistantLayoutProvider>);
    click('fullscreen');
    expect(state()).toMatchObject({ open: true, mode: 'fullscreen', defaultMode: 'sidebar', collapsed: false });
    click('restore');
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
  });

  it('full screen from the window returns to the window', () => {
    render(<AssistantLayoutProvider storageKey={null}><Probe /></AssistantLayoutProvider>);
    click('floating');
    click('fullscreen');
    expect(state()).toMatchObject({ mode: 'fullscreen', defaultMode: 'floating' });
    click('restore');
    expect(state()).toMatchObject({ mode: 'floating', defaultMode: 'floating' });
  });

  it('closing full screen reopens in the previous layout', () => {
    render(<AssistantLayoutProvider storageKey={null}><Probe /></AssistantLayoutProvider>);
    click('fullscreen');
    click('close');
    click('open');
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
  });

  it('restoreMode outside full screen changes nothing', () => {
    render(<AssistantLayoutProvider storageKey={null}><Probe /></AssistantLayoutProvider>);
    click('open');
    const before = renders;
    click('restore');
    expect(renders).toBe(before);
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
  });

  it('full screen is never the opening layout', () => {
    const view = render(<AssistantLayoutProvider storageKey={null}><Probe /></AssistantLayoutProvider>);
    click('default fullscreen');
    expect(state()).toMatchObject({ defaultMode: 'sidebar', mode: 'sidebar' });
    view.unmount();
    render(<AssistantLayoutProvider storageKey={null} defaultMode={'fullscreen'}><Probe /></AssistantLayoutProvider>);
    expect(state()).toMatchObject({ defaultMode: 'sidebar', mode: 'sidebar' });
  });

  it.each([
    ['{"open":true,"mode":"fullscreen","defaultMode":"floating"}', { open: true, mode: 'fullscreen', defaultMode: 'floating' }],
    ['{"mode":"fullscreen","defaultMode":"fullscreen"}', { mode: 'fullscreen', defaultMode: 'sidebar' }],
  ])('parses %s', (raw, expected) => {
    expect(parseAssistantLayout(raw)).toMatchObject(expected);
  });

  it('an open full screen survives a reload', async () => {
    const view = render(<AssistantLayoutProvider><Probe /></AssistantLayoutProvider>);
    await frame();
    click('fullscreen');
    await frame();
    expect(JSON.parse(store.get(DEFAULT_ASSISTANT_LAYOUT_KEY)!)).toMatchObject({ open: true, mode: 'fullscreen', defaultMode: 'sidebar' });
    view.unmount();
    render(<AssistantLayoutProvider><Probe /></AssistantLayoutProvider>);
    await frame();
    expect(state()).toMatchObject({ open: true, mode: 'fullscreen', defaultMode: 'sidebar' });
  });
});
