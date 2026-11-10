import { describe, expect, it } from 'vitest';
import { checkMcpNames, type McpNameSubject } from './mcp-names.js';

function tool(stableKey: string, definitionId: string, kept?: McpNameSubject['kept']): McpNameSubject {
  return { stableKey, definitionId, modelName: definitionId.replace(/\./g, '_'), ...(kept ? { kept } : {}) };
}

describe('checkMcpNames', () => {
  it('reports nothing when every id and name is used once', () => {
    const result = checkMcpNames([
      tool('GET /api/tasks', 'tasks.list'),
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.add', name: 'add_task' }, { id: 'tasks.quick', name: 'quick_task' }]),
    ]);
    expect(result.findings).toEqual([]);
    expect([...result.fallback]).toEqual([]);
  });

  it('lets a tool keep its own generated id next to other kept names', () => {
    const result = checkMcpNames([
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.create', name: 'create_task' }, { id: 'tasks.add', name: 'tasks_create' }]),
    ]);
    expect(result.findings).toEqual([]);
  });

  it('sends a kept name that equals the generated name of another tool back to its generated names', () => {
    const result = checkMcpNames([
      tool('GET /api/tasks', 'tasks.list'),
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.create', name: 'tasks_list' }]),
    ]);
    expect([...result.fallback]).toEqual(['POST /api/tasks']);
    expect(result.findings).toEqual([expect.objectContaining({
      code: 'mcp-tool-names-invalid',
      severity: 'warning',
      subjectRef: 'POST /api/tasks',
      message: 'The MCP name tasks_list kept for POST /api/tasks is also used by GET /api/tasks;'
        + ' POST /api/tasks keeps its generated MCP names meanwhile.',
    })]);
  });

  it('refuses a kept id that equals the contract id of another tool, even when that tool keeps other ids', () => {
    const result = checkMcpNames([
      tool('GET /api/tasks', 'tasks.list', [{ id: 'legacy.list', name: 'legacy_list' }]),
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.list', name: 'create_task' }]),
    ]);
    expect([...result.fallback]).toEqual(['POST /api/tasks']);
    expect(result.findings.map((finding) => [finding.subjectRef, finding.message])).toEqual([[
      'POST /api/tasks',
      'The MCP id tasks.list kept for POST /api/tasks is also used by GET /api/tasks;'
        + ' POST /api/tasks keeps its generated MCP names meanwhile.',
    ]]);
  });

  it('names every collision of one tool in one finding, in a stable order', () => {
    const result = checkMcpNames([
      tool('GET /api/tasks', 'tasks.list'),
      tool('GET /api/notes', 'notes.list'),
      tool('POST /api/tasks', 'tasks.create', [{ id: 'notes.list', name: 'tasks_list' }]),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toBe(
      'The MCP id notes.list kept for POST /api/tasks is also used by GET /api/notes;'
      + ' the MCP name tasks_list kept for POST /api/tasks is also used by GET /api/tasks;'
      + ' POST /api/tasks keeps its generated MCP names meanwhile.',
    );
  });

  it('checks again after a fallback: the generated names it returns to can collide too', () => {
    // POST is sent back (its name equals the generated name of the notes route); back at tasks_create it meets PUT's kept name.
    const result = checkMcpNames([
      tool('GET /api/notes', 'notes.list'),
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.add', name: 'notes_list' }]),
      tool('PUT /api/tasks', 'tasks.replace', [{ id: 'tasks.put', name: 'tasks_create' }]),
    ]);
    expect([...result.fallback].sort()).toEqual(['POST /api/tasks', 'PUT /api/tasks']);
    expect(result.findings.map((finding) => finding.subjectRef).sort()).toEqual(['POST /api/tasks', 'PUT /api/tasks']);
    expect(result.findings.find((finding) => finding.subjectRef === 'PUT /api/tasks')?.message)
      .toContain('The MCP name tasks_create kept for PUT /api/tasks is also used by POST /api/tasks');
  });

  it('sends both tools back when two kept names collide with each other', () => {
    const result = checkMcpNames([
      tool('POST /api/tasks', 'tasks.create', [{ id: 'tasks.add', name: 'add_task' }]),
      tool('PUT /api/tasks', 'tasks.replace', [{ id: 'tasks.put', name: 'add_task' }]),
    ]);
    expect([...result.fallback].sort()).toEqual(['POST /api/tasks', 'PUT /api/tasks']);
  });
});
