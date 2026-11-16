import { describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { assignDefinitionIds, deriveDefinitionId } from './identity.js';

const request = (stableKey: string, explicitId?: string) => {
  const [method, path] = stableKey.split(' ') as [EndpointMethod, string];
  return { stableKey, method, path, ...(explicitId ? { explicitId } : {}) };
};

describe('definition identity', () => {
  it.each([
    ['GET', '/api/tasks', 'tasks.list'],
    ['GET', '/api/tasks/:id', 'tasks.get'],
    ['POST', '/api/tasks/:id/comments', 'tasksComments.create'],
    ['PATCH', '/api/tasks/:id', 'tasks.update'],
    ['DELETE', '/api/tasks/:id', 'tasks.delete'],
    ['GET', '/api/tasks-by-date', 'tasksByDate.list'],
    ['POST', '/api/2fa/setup', 'api2faSetup.create'],
    ['GET', '/api', 'root.list'],
    ['HEAD', '/api/tasks', 'tasks.head'],
    ['HEAD', '/api/tasks/:id', 'tasks.check'],
  ] as const)('derives %s %s as %s', (method, path, expected) => {
    expect(deriveDefinitionId({ method, path })).toBe(expected);
  });

  it('prefers contract ids, then previous names, then derived names', () => {
    const { ids, findings } = assignDefinitionIds([
      request('GET /api/tasks', 'tasks.search'),
      request('POST /api/tasks'),
      request('GET /api/notes'),
    ], new Map([['GET /api/tasks', 'tasks.list'], ['POST /api/tasks', 'tasks.add']]));
    expect(Object.fromEntries(ids)).toEqual({
      'GET /api/tasks': 'tasks.search',
      'POST /api/tasks': 'tasks.add',
      'GET /api/notes': 'notes.list',
    });
    expect(findings).toEqual([]);
  });

  it('disambiguates colliding derived names by method and keeps earlier names sticky', () => {
    const fresh = assignDefinitionIds([request('PATCH /api/tasks/:id'), request('PUT /api/tasks/:id')], new Map());
    expect(Object.fromEntries(fresh.ids)).toEqual({
      'PATCH /api/tasks/:id': 'tasks.updatePatch',
      'PUT /api/tasks/:id': 'tasks.updatePut',
    });
    const sticky = assignDefinitionIds(
      [request('PATCH /api/tasks/:id'), request('PUT /api/tasks/:id')],
      new Map([['PATCH /api/tasks/:id', 'tasks.update']]),
    );
    expect(Object.fromEntries(sticky.ids)).toEqual({
      'PATCH /api/tasks/:id': 'tasks.update',
      'PUT /api/tasks/:id': 'tasks.updatePut',
    });
  });

  it('reports conflicting contract ids as errors and invalid ones as warnings', () => {
    const conflict = assignDefinitionIds([
      request('GET /api/a', 'shared.list'),
      request('GET /api/b', 'shared.list'),
    ], new Map());
    expect(conflict.findings.map((finding) => [finding.code, finding.severity, finding.subjectRef]))
      .toEqual([['definition-id-conflict', 'error', 'GET /api/b']]);
    const invalid = assignDefinitionIds([request('GET /api/a', 'Not Valid')], new Map());
    expect(invalid.ids.get('GET /api/a')).toBe('a.list');
    expect(invalid.findings.map((finding) => finding.code)).toEqual(['definition-id-invalid']);
  });

  it('lets an x-glirastes-name win over the previous name and names the extension in its findings', () => {
    const named = (stableKey: string, explicitId: string) => ({ ...request(stableKey, explicitId), explicitIdSource: 'x-glirastes-name' });
    const previous = new Map([['GET /api/tags', 'tags.list'], ['PATCH /api/tags/:id', 'tags.update']]);
    const first = assignDefinitionIds([named('GET /api/tags', 'list_tags'), request('PATCH /api/tags/:id')], previous);
    expect(Object.fromEntries(first.ids)).toEqual({ 'GET /api/tags': 'list_tags', 'PATCH /api/tags/:id': 'tags.update' });
    // Stable across refreshes: the previous inventory now holds the explicit name.
    const again = assignDefinitionIds([named('GET /api/tags', 'list_tags')], new Map([['GET /api/tags', 'list_tags']]));
    expect(again.ids.get('GET /api/tags')).toBe('list_tags');
    // A sticky name another operation held gives way to the explicit name.
    const taken = assignDefinitionIds(
      [named('GET /api/labels', 'tags.list'), request('GET /api/tags')],
      new Map([['GET /api/tags', 'tags.list']]),
    );
    expect(Object.fromEntries(taken.ids)).toEqual({ 'GET /api/labels': 'tags.list', 'GET /api/tags': 'tags.listGet' });

    const invalid = assignDefinitionIds([named('GET /api/a', 'List Tags')], new Map());
    expect(invalid.ids.get('GET /api/a')).toBe('a.list');
    expect(invalid.findings[0]).toMatchObject({ code: 'definition-id-invalid', severity: 'warning' });
    expect(invalid.findings[0]!.message).toBe('x-glirastes-name "List Tags" is not a valid tool name; a derived name is used.');
    expect(invalid.findings[0]!.nextAction).toContain('x-glirastes-name');
    const conflict = assignDefinitionIds([named('GET /api/a', 'list_tags'), named('GET /api/b', 'list_tags')], new Map());
    expect(conflict.findings.map((finding) => [finding.code, finding.severity, finding.message])).toEqual([
      ['definition-id-conflict', 'error', 'x-glirastes-name list_tags is already used by GET /api/a.'],
    ]);
  });

  it('reports names that collide after model-safe encoding', () => {
    const { findings } = assignDefinitionIds([
      request('GET /api/tasks'),
      request('GET /api/other', 'tasks_list'),
    ], new Map());
    expect(findings.map((finding) => finding.code)).toEqual(['definition-id-conflict']);
  });
});
