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

  it('reports names that collide after model-safe encoding', () => {
    const { findings } = assignDefinitionIds([
      request('GET /api/tasks'),
      request('GET /api/other', 'tasks_list'),
    ], new Map());
    expect(findings.map((finding) => finding.code)).toEqual(['definition-id-conflict']);
  });
});
