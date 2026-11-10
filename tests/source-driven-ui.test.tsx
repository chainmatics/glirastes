// @vitest-environment jsdom
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchToolResultUiActions } from 'glirastes/browser';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  refreshWithCli,
  removeCopiedApps,
} from './support/tool-runtime.js';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  search: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const TASKS = [
  { id: '1', title: 'Review release', status: 'open' },
  { id: '2', title: 'Write tests', status: 'done' },
];

beforeAll(assertBuiltSdk);
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  navigation.push.mockReset();
  navigation.search = '';
  await removeCopiedApps();
});

/** A refreshed copy of the native app, its booted chat runtime and its own UI modules. */
async function nativeApp() {
  const root = await copyApp(NATIVE_APP, '.ui-proof-');
  await refreshWithCli(root);
  const app = await bootApp(root);
  const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
  const bridge = await import(pathToFileURL(join(root, 'src/glirastes-bridge.jsx')).href) as {
    GlirastesBridge: ComponentType;
  };
  const tasksPage = await import(pathToFileURL(join(root, 'src/app/(app)/tasks/page.jsx')).href) as {
    default: ComponentType;
  };
  /** What the chat does with a tool result: hand its generated UI action to the page-wide bus. */
  const run = async (name: string, input: unknown) => {
    const result = await turn.execute(name, input);
    expect(result).toMatchObject({ success: true });
    await act(async () => { await dispatchToolResultUiActions(result); });
  };
  return { app, turn, run, Bridge: bridge.GlirastesBridge, TasksPage: tasksPage.default };
}

describe('native UI through generated tools and the app bridge', () => {
  it('navigates and filters with the router the app hands to its bridge', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const native = await nativeApp();
    expect(native.app.disabled).toEqual([]);
    render(createElement(native.Bridge));
    await native.run('ui_navigate', { destination: '/overview' });
    await native.run('ui_filter_tasks', { status: 'done' });
    expect(navigation.push.mock.calls).toEqual([['/overview'], ['/tasks?status=done']]);
    await expect(native.turn.execute('ui_navigate', { destination: '/reports' })).rejects.toThrow('Input does not match');
    await expect(native.turn.execute('ui_filter_tasks', { status: 'blocked' })).rejects.toThrow('Input does not match');
    expect(network).not.toHaveBeenCalled();
  }, 120_000);

  it('runs the page’s own client action with a validated payload and shows the URL filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tasks: TASKS }));
    navigation.search = 'status=done';
    const native = await nativeApp();
    render(createElement(native.TasksPage));
    await screen.findByText('Write tests');
    expect(screen.queryByText('Review release')).toBeNull();
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('done');
    await native.run('ui_tasks_highlight', { title: 'Write tests' });
    await waitFor(() => expect(screen.getByText('Write tests').getAttribute('aria-current')).toBe('true'));
    await expect(native.turn.execute('ui_tasks_highlight', { id: '2' })).rejects.toThrow('Input does not match');
    // The page's own Zod contract stays the last word on what its handler accepts.
    const empty = await native.turn.execute('ui_tasks_highlight', { title: '' });
    await expect(dispatchToolResultUiActions(empty)).rejects.toThrow('Invalid payload for UI action tasks.highlight');
    expect(screen.getByText('Write tests').getAttribute('aria-current')).toBe('true');
  }, 120_000);

  it('uses the same filter definition for the ordinary page controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tasks: TASKS }));
    const native = await nativeApp();
    render(createElement(native.TasksPage));
    await screen.findByText('Review release');
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    select.value = 'open';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(navigation.push).toHaveBeenCalledWith('/tasks?status=open');
  }, 120_000);

  it('stops navigating once the bridge unmounts', async () => {
    const native = await nativeApp();
    const view = render(createElement(native.Bridge));
    view.unmount();
    await native.run('ui_navigate', { destination: '/overview' });
    expect(navigation.push).not.toHaveBeenCalled();
  }, 120_000);
});
