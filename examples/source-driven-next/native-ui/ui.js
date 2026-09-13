import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
const configSchema = z.object({ views: z.array(z.object({
  id: identifier, label: z.string().min(1).max(100),
  filters: z.array(z.object({ key: identifier, label: z.string().min(1).max(100),
    values: z.array(z.string().min(1).max(80)).min(1).max(50),
  }).strict()).max(20),
}).strict()).min(1).max(30) }).strict();

export function createUiContracts(rawConfig) {
  const config = configSchema.parse(rawConfig);
  if (new Set(config.views.map((view) => view.id)).size !== config.views.length
    || config.views.some((view) => new Set(view.filters.map((filter) => filter.key)).size !== view.filters.length)) {
    throw new Error('Duplicate UI identifiers');
  }
  const navigationSchema = z.object({ view: z.enum(config.views.map((view) => view.id)) }).strict();
  const filterBranches = config.views.filter((view) => view.filters.length).map((view) =>
    z.object({ view: z.literal(view.id), filters: z.object(Object.fromEntries(view.filters.map((filter) =>
      [filter.key, z.enum(filter.values).optional()]))).strict() }).strict());
  const filterSchema = filterBranches.length === 0 ? undefined
    : filterBranches.length === 1 ? filterBranches[0] : z.union(filterBranches);
  return { config, navigationSchema, filterSchema };
}

/** Ordinary app UI. Both mouse/keyboard controls and integration use its schemas. */
export function mountNativeUi(container, rawConfig, rows) {
  const { config, navigationSchema, filterSchema } = createUiContracts(rawConfig);
  let viewId = config.views[0].id;
  let selected = {};
  let disposed = false;
  const element = (tag, text) => {
    const node = container.ownerDocument.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const render = () => {
    if (disposed) return;
    const view = config.views.find((entry) => entry.id === viewId);
    const nav = element('nav');
    nav.setAttribute('aria-label', 'Views');
    for (const entry of config.views) {
      const button = element('button', entry.label);
      button.type = 'button';
      button.onclick = () => ui.navigate({ view: entry.id });
      nav.append(button);
    }
    const heading = element('h1', view.label);
    const controls = element('div');
    for (const filter of view.filters) {
      const label = element('label', filter.label);
      const select = element('select');
      select.setAttribute('aria-label', filter.label);
      const all = element('option', 'All');
      all.value = '';
      select.append(all);
      for (const value of filter.values) {
        const option = element('option', value);
        option.value = value;
        select.append(option);
      }
      select.value = selected[filter.key] ?? '';
      select.onchange = () => {
        const next = { ...selected };
        if (select.value) next[filter.key] = select.value;
        else delete next[filter.key];
        ui.filter({ view: viewId, filters: next });
      };
      label.append(select);
      controls.append(label);
    }
    const list = element('ul');
    for (const row of rows.filter((row) => Object.entries(selected).every(([key, value]) => row[key] === value))) {
      list.append(element('li', row.title));
    }
    container.replaceChildren(nav, heading, controls, list);
  };
  const ui = {
    navigate(input) {
      if (disposed) throw new Error('UI is disposed');
      viewId = navigationSchema.parse(input).view;
      selected = {};
      render();
    },
    filter(input) {
      if (disposed || !filterSchema) throw new Error('Filter unavailable');
      const parsed = filterSchema.parse(input);
      viewId = parsed.view;
      selected = parsed.filters;
      render();
    },
    dispose() { disposed = true; container.replaceChildren(); },
  };
  render();
  return ui;
}
