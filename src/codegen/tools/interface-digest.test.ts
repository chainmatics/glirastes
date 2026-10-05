import { describe, expect, it } from 'vitest';
import { computeInterfaceDigest } from './interface-digest.js';

const base = {
  method: 'POST',
  path: '/api/tasks/:id',
  pathParams: ['id'],
  queryParams: ['b', 'a'],
  schemaBindings: ['body:src/app/api/tasks/schemas.ts#createTask'],
  bodyKeys: ['title', 'due'] as string[] | 'opaque',
};

describe('computeInterfaceDigest', () => {
  it('is a sha256 base64url digest independent of list order and duplicates', () => {
    const digest = computeInterfaceDigest(base);
    expect(digest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(computeInterfaceDigest({
      ...base, queryParams: ['a', 'b', 'a'], bodyKeys: ['due', 'title'],
    })).toBe(digest);
  });

  it('changes with every interface fact', () => {
    const digest = computeInterfaceDigest(base);
    for (const change of [
      { method: 'PUT' },
      { path: '/api/tasks/:taskId' },
      { pathParams: ['taskId'] },
      { queryParams: ['a'] },
      { schemaBindings: [] },
      { bodyKeys: 'opaque' as const },
      { bodyKeys: ['title'] },
    ]) {
      expect(computeInterfaceDigest({ ...base, ...change })).not.toBe(digest);
    }
  });

  it('ignores whitespace-only differences in the handler text fallback', () => {
    const opaque = { ...base, schemaBindings: [], bodyKeys: 'opaque' as const };
    expect(computeInterfaceDigest({ ...opaque, handlerText: 'return  save(\n body);' }))
      .toBe(computeInterfaceDigest({ ...opaque, handlerText: 'return save( body);' }));
    expect(computeInterfaceDigest({ ...opaque, handlerText: 'return save(body);' }))
      .not.toBe(computeInterfaceDigest({ ...opaque, handlerText: 'return drop(body);' }));
  });
});
