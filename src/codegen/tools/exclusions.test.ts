import { describe, expect, expectTypeOf, it } from 'vitest';
import { findExclusion, hasAiIgnoreMarker, importsChatHandler, matchesExcludePattern } from './exclusions.js';
import type { ExcludedTool } from './types.js';

const subject = (method: string, path: string, chatHandler = false) => ({
  stableKey: `${method} ${path}`, method, path, chatHandler,
});

describe('tool exclusions', () => {
  it.each([
    ['POST', '/api/auth/login', 'auth-route'],
    ['GET', '/api/auth', 'auth-route'],
    ['POST', '/api/webhooks/stripe', 'webhook'],
    ['POST', '/api/stripe-webhook', 'webhook'],
    ['GET', '/api/cron/daily', 'cron'],
    ['GET', '/api/oauth/callback', 'callback'],
    ['GET', '/api/health', 'health'],
    ['GET', '/api/files/*slug', 'catch-all'],
    ['POST', '/api/chat', 'chat-handler'],
    ['POST', '/api/ai/chat', 'chat-handler'],
    ['POST', '/api/ai/chat-v2', 'chat-handler'],
    ['POST', '/api/stt/token', 'stt-handler'],
    ['POST', '/api/transcribe', 'stt-handler'],
    ['GET', '/api/ai/speech-token', 'stt-handler'],
    ['GET', '/api/ai/speech-stream', 'stt-handler'],
    ['POST', '/api/ai/speech-transcribe', 'stt-handler'],
  ])('excludes %s %s by default (%s)', (method, path, reason) => {
    expect(findExclusion(subject(method, path), [])).toEqual({
      stableKey: `${method} ${path}`, reason, origin: 'default',
    });
  });

  it('excludes chat handlers wherever they live and keeps ordinary routes', () => {
    expect(findExclusion(subject('POST', '/api/assistant', true), [])?.reason).toBe('chat-handler');
    expect(findExclusion(subject('GET', '/api/tasks'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/authors'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/meetings/:id/transcript'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/teams/:id/chat-messages'), [])).toBeUndefined();
  });

  it('detects chat handler imports from the SDK, app wrappers around it and the legacy agentic packages only', () => {
    expect(importsChatHandler("import { createAiChatHandler } from 'glirastes/server/nextjs';")).toBe(true);
    expect(importsChatHandler("import { foo, createAiChatHandler } from '@chainmatics/agentic-server';")).toBe(true);
    expect(importsChatHandler("import { createGetItDoneChatHandler } from '@/lib/glirastes/chat-handler';")).toBe(true);
    expect(importsChatHandler("import type { createAiChatHandler } from 'glirastes/server/nextjs';")).toBe(false);
    expect(importsChatHandler("import { createAiChatHandler } from './local';")).toBe(false);
  });

  it('applies policy patterns with an optional method and segment globs', () => {
    const rules = [{ match: 'POST /api/internal/**', reason: 'internal' }, { match: '/api/admin/*', reason: 'admin only' }];
    expect(findExclusion(subject('POST', '/api/internal/jobs/:id'), rules))
      .toEqual({ stableKey: 'POST /api/internal/jobs/:id', reason: 'internal', origin: 'policy' });
    expect(findExclusion(subject('GET', '/api/internal/jobs'), rules)).toBeUndefined();
    expect(findExclusion(subject('DELETE', '/api/admin/users'), rules)?.reason).toBe('admin only');
    expect(findExclusion(subject('GET', '/api/admin/users/:id'), rules)).toBeUndefined();
    expect(matchesExcludePattern('* /api/**', { method: 'PUT', path: '/api/x' })).toBe(true);
    expect(matchesExcludePattern('not a pattern', { method: 'GET', path: '/api/x' })).toBe(false);
  });

  it('matches only patterns the policy file grammar accepts', () => {
    const target = { method: 'GET', path: '/api/admin-users' };
    expect(matchesExcludePattern('GET /api/admin-users', target)).toBe(true);
    expect(matchesExcludePattern('get /api/admin-users', target)).toBe(false);
    expect(matchesExcludePattern('GET /api/admin-*', target)).toBe(false);
    expect(matchesExcludePattern('GET /api/**x', target)).toBe(false);
    expect(matchesExcludePattern('/api/[id]', { method: 'GET', path: '/api/:id' })).toBe(false);
    expect(matchesExcludePattern('/api/files/*slug', { method: 'GET', path: '/api/files/*slug' })).toBe(true);
  });

  it('admits code-detected exclusions such as unsupported methods in the origin type', () => {
    expectTypeOf<ExcludedTool['origin']>().toEqualTypeOf<'default' | 'policy' | 'code'>();
  });

  it('reads // @ai-ignore in the leading comments of a route file as an exclusion in code', () => {
    expect(hasAiIgnoreMarker('// @ai-ignore - Logo file upload, admin UI only\nexport async function POST() {}\n')).toBe(true);
    expect(hasAiIgnoreMarker('\uFEFF/**\n * Internal.\n * @ai-ignore\n */\nexport async function GET() {}\n')).toBe(true);
    expect(hasAiIgnoreMarker('export async function GET() {\n  // @ai-ignore\n}\n')).toBe(false);
    expect(hasAiIgnoreMarker('// @ai-ignored once\nexport async function GET() {}\n')).toBe(false);
    expect(hasAiIgnoreMarker("import { db } from '@/lib/db';\n// @ai-ignore\n")).toBe(false);
    expect(findExclusion({ ...subject('POST', '/api/tenant/logo'), aiIgnore: true }, []))
      .toEqual({ stableKey: 'POST /api/tenant/logo', reason: 'ai-ignore', origin: 'code' });
    expect(findExclusion({ ...subject('POST', '/api/auth/login'), aiIgnore: true }, [])?.reason).toBe('auth-route');
    expect(findExclusion({ ...subject('POST', '/api/internal/sync'), aiIgnore: true }, [{ match: 'POST /api/internal/**', reason: 'internal' }]))
      .toEqual({ stableKey: 'POST /api/internal/sync', reason: 'internal', origin: 'policy' });
  });
});
