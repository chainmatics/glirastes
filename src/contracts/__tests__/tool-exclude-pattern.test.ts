import { describe, expect, it } from 'vitest';
import { parseExcludePattern } from '../tool-exclude-pattern.js';

describe('parseExcludePattern', () => {
  it.each([
    ['POST /api/internal/**', 'POST', ['api', 'internal', '**']],
    ['/api/admin/*', undefined, ['api', 'admin', '*']],
    ['* /api/**', undefined, ['api', '**']],
    ['  HEAD   /api/health  ', 'HEAD', ['api', 'health']],
    ['GET /api/tasks/:id', 'GET', ['api', 'tasks', ':id']],
    // A catch-all stable-key segment (`*slug`) matches literally.
    ['DELETE /api/files/*slug', 'DELETE', ['api', 'files', '*slug']],
    ['/', undefined, []],
  ])('accepts %j', (pattern, method, segments) => {
    expect(parseExcludePattern(pattern)).toEqual({ method, segments });
  });

  it.each([
    ['a lowercase method', 'get /api/x'],
    ['a method outside the grammar', 'OPTIONS /api/x'],
    ['a stray token before the path', 'GET please /api/x'],
    ['a stray token after the path', 'GET /api/x extra'],
    ['no space after the method', 'GET/api/x'],
    ['a method without a path', 'GET'],
    ['a path without a leading slash', 'api/x'],
    ['an empty pattern', ''],
    ['text that is not a pattern', 'not a pattern'],
    ['a partial glob', '/api/admin-*'],
    ['a glob inside a segment', '/api/a*b/x'],
    ['a doubled glob with a name', '/api/**slug'],
    ['Next.js bracket syntax', '/api/tasks/[id]'],
    ['Next.js catch-all syntax', 'GET /api/files/[...slug]'],
    ['Next.js route-group syntax', '/api/(admin)/users'],
  ])('rejects %s', (_label, pattern) => {
    expect(parseExcludePattern(pattern)).toBeUndefined();
  });
});
