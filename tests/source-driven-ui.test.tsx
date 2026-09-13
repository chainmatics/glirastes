// @vitest-environment jsdom
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from 'glirastes/react';
import { generateReference, tenantId } from '../examples/source-driven-next/adapter.mjs';

const examples = resolve('examples/source-driven-next');
const roots: string[] = [];
const disposals: Array<() => void> = [];
const rows = [{ title: 'Review release', status: 'open', priority: 'high' }, { title: 'Write tests', status: 'done', priority: 'low' }];
async function fixture(config?: unknown) {
  const root = await mkdtemp(join(examples, '.ui-proof-'));
  roots.push(root);
  await cp(join(examples, 'native'), root, { recursive: true });
  await mkdir(join(root, 'node_modules'));
  await symlink(resolve('.'), join(root, 'node_modules/glirastes'), 'dir');
  await cp(join(examples, 'native-ui'), join(root, 'src'), { recursive: true });
  await cp(join(examples, 'ui-bridge.js'), join(root, 'src/glirastes-ui-bridge.js'));
  if (config) await writeFile(join(root, 'src/ui-config.json'), JSON.stringify(config));
  const auth = await import(pathToFileURL(join(root, 'src/auth.js')).href);
  const native = await import(pathToFileURL(join(root, 'src/ui.js')).href);
  const { NativeUiBridge } = await import(pathToFileURL(join(root, 'src/glirastes-ui-bridge.js')).href);
  const uiConfig = JSON.parse(await readFile(join(root, 'src/ui-config.json'), 'utf8'));
  const container = document.createElement('div');
  document.body.append(container);
  const ui = native.mountNativeUi(container, uiConfig, rows);
  const bus = new UiActionBus();
  const mounted = render(createElement(NativeUiBridge, { bus, ui }));
  disposals.push(() => { mounted.unmount(); ui.dispose(); container.remove(); });
  const token = auth.createSession({ subjectId: 'alice', tenantId, roles: ['member'], attributes: {} });
  const request = new Request('http://fixture.local/chat', { headers: { cookie: `session=${token}` } });
  return { root, container, uiConfig, bus, mounted, request, resolvePrincipal: () => auth.resolveSession(request) };
}
async function invoke(app: Awaited<ReturnType<typeof fixture>>, generated: any, key: string, input: unknown) {
  const turn = generated.createTurn(app);
  const result = await turn.execute(key, input);
  expect(result.success).toBe(true);
  await app.bus.dispatch(result.uiAction);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
  cleanup();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('UI-owned navigation and filters through the local runtime', () => {
  it('changes the rendered view and filtered rows via mounted SDK handlers', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const app = await fixture();
    const generated = await generateReference({ rootDir: app.root });
    await invoke(app, generated, 'UI navigate', { view: 'overview' });
    expect(app.container.querySelector('h1')?.textContent).toBe('Overview');
    await invoke(app, generated, 'UI filter', { view: 'tasks', filters: { status: 'done' } });
    expect(app.container.querySelector('h1')?.textContent).toBe('Tasks');
    expect([...app.container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Write tests']);
    expect(app.container.querySelector('select')?.value).toBe('done');
    expect(network).not.toHaveBeenCalled();
  });

  it('tracks added, renamed and removed views without a separate tool entry', async () => {
    const first = await fixture();
    const a = await generateReference({ rootDir: first.root });
    const config = structuredClone(first.uiConfig);
    config.views.push({ id: 'reports', label: 'Reports', filters: [] });
    const second = await fixture(config);
    const b = await generateReference({ rootDir: second.root, previous: a.state });
    await invoke(second, b, 'UI navigate', { view: 'reports' });
    expect(second.container.querySelector('h1')?.textContent).toBe('Reports');
    config.views[2] = { id: 'insights', label: 'Insights', filters: [] };
    config.views = config.views.filter((view: any) => view.id !== 'overview');
    const third = await fixture(config);
    const c = await generateReference({ rootDir: third.root, previous: b.state });
    await invoke(third, c, 'UI navigate', { view: 'insights' });
    expect(third.container.querySelector('h1')?.textContent).toBe('Insights');
    for (const view of ['reports', 'overview']) {
      await expect(c.createTurn(third).execute('UI navigate', { view })).rejects.toThrow('Input');
    }
    const uiId = (g: any) => g.state.inventory.executions.find((entry: any) => entry.stableKey === 'UI navigate').toolId;
    expect(uiId(c)).toBe(uiId(a));
    expect(c.changes.changed).toContain(uiId(c));
  });

  it('tracks added and removed filters and tombstones the last filter tool', async () => {
    const first = await fixture();
    const a = await generateReference({ rootDir: first.root });
    const config = structuredClone(first.uiConfig);
    config.views[0].filters = [{ key: 'priority', label: 'Priority', values: ['high', 'low'] }];
    const second = await fixture(config);
    const b = await generateReference({ rootDir: second.root, previous: a.state });
    await invoke(second, b, 'UI filter', { view: 'tasks', filters: { priority: 'high' } });
    expect([...second.container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Review release']);
    await expect(b.createTurn(second).execute('UI filter', { view: 'tasks', filters: { status: 'open' } })).rejects.toThrow('Input');
    config.views[0].filters[0].values = ['urgent', 'low'];
    const changed = await fixture(config);
    const updated = await generateReference({ rootDir: changed.root, previous: b.state });
    await invoke(changed, updated, 'UI filter', { view: 'tasks', filters: { priority: 'low' } });
    expect([...changed.container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Write tests']);
    expect([...changed.container.querySelectorAll('option')].map((item) => item.value)).toEqual(['', 'urgent', 'low']);
    await expect(updated.createTurn(changed).execute('UI filter', { view: 'tasks', filters: { priority: 'high' } })).rejects.toThrow('Input');
    config.views[0].filters = [];
    const third = await fixture(config);
    const c = await generateReference({ rootDir: third.root, previous: updated.state });
    await expect(c.createTurn(third).execute('UI filter', { view: 'tasks', filters: {} })).rejects.toThrow('unavailable');
    expect(c.changes.removed).toHaveLength(1);
  });

  it('rejects missing bridge/config instead of reporting a current UI inventory', async () => {
    const app = await fixture();
    const generated = await generateReference({ rootDir: app.root });
    await rm(join(app.root, 'src/glirastes-ui-bridge.js'));
    await expect(generateReference({ rootDir: app.root, previous: generated.state })).rejects.toThrow();
    await rm(join(app.root, 'src/ui-config.json'));
    await expect(generateReference({ rootDir: app.root, previous: generated.state })).rejects.toThrow();
  });

  it('cleans up SDK subscriptions on unmount', async () => {
    const app = await fixture();
    const generated = await generateReference({ rootDir: app.root });
    app.mounted.unmount();
    await invoke(app, generated, 'UI navigate', { view: 'overview' });
    expect(app.container.querySelector('h1')?.textContent).toBe('Tasks');
  });

  it('uses the same configuration for ordinary app controls', async () => {
    const app = await fixture();
    const overview = [...app.container.querySelectorAll('button')].find((button) => button.textContent === 'Overview')!;
    overview.click();
    expect(app.container.querySelector('h1')?.textContent).toBe('Overview');
    app.container.querySelector('button')!.click();
    const select = app.container.querySelector('select')!;
    select.value = 'open';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...app.container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Review release']);
  });
});
