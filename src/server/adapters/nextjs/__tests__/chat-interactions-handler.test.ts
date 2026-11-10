import { describe, expect, it, vi } from 'vitest';
import type { ChatInteractionsData } from '../../../../contracts/chat-interactions.js';
import { createChatInteractionsHandler } from '../index.js';
import { principal, snapshot } from './command-fixtures.js';

const interactions: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { en: 'Task', de: 'Aufgabe' },
    search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'], idField: 'id', labelField: 'title' },
    actions: [{ id: 'task.tasks.archive', label: 'Archive', entityArg: 'id', run: { kind: 'tool', tool: 'tasks.archive' } }],
  }],
  commands: [
    { id: 'tasks.search', label: 'Search tasks', run: { kind: 'tool', tool: 'tasks.list' } },
    { id: 'standup', label: 'Stand-up', run: { kind: 'prompt', prompt: 'Summarize my day.' } },
    { id: 'reports.open', label: 'Reports', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/reports' } } },
  ],
};

const request = () => new Request('https://app.example/api/chat', { headers: { cookie: 'session=1' } });

describe('createChatInteractionsHandler', () => {
  it('serves the interactions with overrides applied, never cached across users', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      overrides: { schemaVersion: 1, commands: { standup: { label: { de: 'Tagesrückblick', en: 'Stand-up' } } } },
    });
    const response = await handler(request());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as ChatInteractionsData;
    expect(body.commands.find((command) => command.id === 'standup')!.label).toEqual({ de: 'Tagesrückblick', en: 'Stand-up' });
    expect(body.entities).toEqual(interactions.entities);
  });

  it('loads when an override names a command the generator no longer derives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const handler = createChatInteractionsHandler({
        interactions,
        overrides: {
          schemaVersion: 1,
          commands: {
            'filter.tasks': { label: { de: 'Aufgaben filtern', en: 'Filter tasks' }, icon: 'filter' },
            standup: { label: 'Tagesrückblick' },
          },
        },
      });
      const body = await (await handler(request())).json() as ChatInteractionsData;
      expect(body.commands.map((command) => command.id)).toEqual(['tasks.search', 'standup', 'reports.open']);
      expect(body.commands.find((command) => command.id === 'standup')!.label).toBe('Tagesrückblick');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('commands.filter.tasks');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses an invalid override file at creation, like an invalid policy', () => {
    expect(() => createChatInteractionsHandler({ interactions, overrides: { schemaVersion: 1, commands: { standup: { onRun: 'x' } } } }))
      .toThrow(/commands\.standup\.onRun: unknown field/);
  });

  it('leaves out what this user may not run and needs a session', async () => {
    const managed = (options: Parameters<typeof snapshot>[1], roles?: string[]) => createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async (incoming) => (incoming.headers.get('cookie') ? principal(roles) : undefined),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId, options, roles),
      },
    });
    expect((await managed({})(new Request('https://app.example/api/chat'))).status).toBe(401);

    const all = await (await managed({})(request())).json() as ChatInteractionsData;
    expect(all.commands.map((command) => command.id)).toEqual(['tasks.search', 'standup']);
    expect(all.entities[0]!.actions!.map((action) => action.id)).toEqual(['task.tasks.archive']);

    const archiveDisabled = await (await managed({ archiveEnabled: false })(request())).json() as ChatInteractionsData;
    const { actions: _actions, ...searchOnly } = interactions.entities[0]!;
    expect(archiveDisabled.entities).toEqual([searchOnly]);

    const listForbidden = await (await managed({ listRoles: ['admin'], archiveEnabled: false })(request())).json() as ChatInteractionsData;
    expect(listForbidden).toEqual({ schemaVersion: 1, entities: [], commands: [interactions.commands[1]] });
  });

  it('keeps an entity whose action this user may run when its search is not allowed', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId, { listRoles: ['admin'] }),
      },
    });
    const body = await (await handler(request())).json() as ChatInteractionsData;
    const { search: _search, ...actionsOnly } = interactions.entities[0]!;
    expect(body.entities).toEqual([actionsOnly]);
    expect(body.commands.map((command) => command.id)).toEqual(['standup']);
  });

  it('answers 503 without leaking the interactions when no snapshot can be pinned', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async () => { throw new Error('platform unreachable'); },
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'Chat interactions unavailable' });
  });

  it('hides a revoked tool', async () => {
    const handler = createChatInteractionsHandler({
      interactions,
      managedRuntime: {
        resolvePrincipal: async () => principal(),
        resolveTurnSnapshot: async ({ turnId }) => snapshot(turnId),
        loadRevocations: async ({ snapshot: pinned }) => [{
          revocationId: '019fb710-0000-7000-8000-0000000000f1',
          environmentId: pinned.manifestRevision.environmentId,
          effectiveAt: '2026-10-05T09:00:00.000Z',
          reasonCode: 'incident',
          toolIds: [pinned.manifestRevision.tools[1]!.toolId],
          agentRevisionIds: [],
          policyRevisionIds: [],
          signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'c2lnbmF0dXJl' },
        }],
      },
    });
    const body = await (await handler(request())).json() as ChatInteractionsData;
    expect(body.entities[0]).not.toHaveProperty('actions');
  });
});
