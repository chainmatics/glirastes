import { describe, expect, expectTypeOf, it } from 'vitest';
import { findExclusion, importsChatHandler, matchesExcludePattern } from './exclusions.js';
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
});
