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
    expect([...first.findings, ...again.findings]).toEqual([]);
    // A sticky name another operation held gives way to the explicit name, visibly.
    const taken = assignDefinitionIds(
      [named('GET /api/labels', 'tags.list'), request('GET /api/tags')],
      new Map([['GET /api/tags', 'tags.list']]),
    );
    expect(Object.fromEntries(taken.ids)).toEqual({ 'GET /api/labels': 'tags.list', 'GET /api/tags': 'tags.listGet' });
    expect(taken.findings).toEqual([expect.objectContaining({
      code: 'definition-id-reassigned',
      severity: 'warning',
      subjectRef: 'GET /api/labels',
      message: 'x-glirastes-name tags.list on GET /api/labels was the name of GET /api/tags, which is now tags.listGet.',
    })]);
    expect(taken.findings[0]!.nextAction).toContain('tool-semantics.json');
    expect(taken.findings[0]!.nextAction).toContain('stableKey');

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

  it('reports an explicit id that takes the name another tool held, whoever declared it', () => {
    // A contract id of any source takes a held name the same way.
    const contract = assignDefinitionIds(
      [request('GET /api/labels', 'tags.list'), request('GET /api/tags')],
      new Map([['GET /api/tags', 'tags.list'], ['GET /api/labels', 'labels.list']]),
    );
    expect(contract.findings.map((finding) => [finding.code, finding.subjectRef, finding.message])).toEqual([
      ['definition-id-reassigned', 'GET /api/labels', 'Contract id tags.list on GET /api/labels was the name of GET /api/tags, which is now tags.listGet.'],
    ]);
    // Both renamed at once: the previous holder's new explicit name is named.
    const both = assignDefinitionIds(
      [request('GET /api/labels', 'tags.list'), request('GET /api/tags', 'tags.search')],
      new Map([['GET /api/tags', 'tags.list']]),
    );
    expect(both.findings.map((finding) => finding.message)).toEqual([
      'Contract id tags.list on GET /api/labels was the name of GET /api/tags, which is now tags.search.',
    ]);
    // Settled: the next refresh sees the names it wrote.
    expect(assignDefinitionIds(
      [request('GET /api/labels', 'tags.list'), request('GET /api/tags')],
      new Map([['GET /api/labels', 'tags.list'], ['GET /api/tags', 'tags.listGet']]),
    ).findings).toEqual([]);
    // The earlier holder is gone (its route moved): the name is free, nothing is renamed.
    expect(assignDefinitionIds(
      [request('GET /api/v2/tags', 'tags.list')],
      new Map([['GET /api/tags', 'tags.list']]),
    ).findings).toEqual([]);
    // An explicit id that loses a conflict takes nothing over.
    const conflict = assignDefinitionIds(
      [request('GET /api/a', 'tags.list'), request('GET /api/b', 'tags.list'), request('GET /api/tags')],
      new Map([['GET /api/tags', 'tags.list']]),
    );
    expect(conflict.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['definition-id-conflict', 'GET /api/b'],
      ['definition-id-reassigned', 'GET /api/a'],
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
