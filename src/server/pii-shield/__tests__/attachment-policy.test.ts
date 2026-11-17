import { describe, expect, it } from 'vitest';
import { attachmentDecision, BLOCKED_ATTACHMENTS, resolveAttachmentPolicy, screenshotStatusText } from '../attachment-policy.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('screenshot policy resolution', () => {
  it('defaults to blocked', () => {
    expect(resolveAttachmentPolicy()).toMatchObject({ screenshots: 'blocked', decidedBy: 'default' });
    expect(BLOCKED_ATTACHMENTS.screenshots).toBe('blocked');
  });

  it('takes the most restrictive rule; a user or browser choice never widens app or tenant', () => {
    expect(resolveAttachmentPolicy({ app: 'blocked', user: 'allow-original' })).toMatchObject({ screenshots: 'blocked', decidedBy: 'app' });
    expect(resolveAttachmentPolicy({ app: 'allow-original', tenant: 'blocked', user: 'allow-original' })).toMatchObject({ screenshots: 'blocked', decidedBy: 'tenant' });
    expect(resolveAttachmentPolicy({ app: 'allow-original', tenant: 'allow-original', user: 'blocked' })).toMatchObject({ screenshots: 'blocked', decidedBy: 'user' });
    expect(resolveAttachmentPolicy({ app: 'allow-original', tenant: 'allow-original' })).toMatchObject({ screenshots: 'allow-original' });
  });

  it('treats unknown values as blocked', () => {
    expect(resolveAttachmentPolicy({ app: 'allow-original', user: 'yes' as never }).screenshots).toBe('blocked');
    expect(resolveAttachmentPolicy({ app: 'ALLOW' as never }).screenshots).toBe('blocked');
  });

  it('is frozen for the turn', () => {
    const policy = resolveAttachmentPolicy({ app: 'allow-original' });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => { (policy as { screenshots: string }).screenshots = 'blocked'; }).toThrow();
  });
});

describe('per-part decision', () => {
  const allow = resolveAttachmentPolicy({ app: 'allow-original' });

  it('allows only inline images of allowed types to vision-capable models', () => {
    expect(attachmentDecision({ mediaType: 'image/png', data: png }, allow, true)).toEqual({ allowed: true });
    expect(attachmentDecision({ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, allow, true)).toEqual({ allowed: true });
    expect(attachmentDecision({ mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }, allow, true)).toEqual({ allowed: true });
  });

  it.each([
    ['blocked policy', { mediaType: 'image/png', data: png }, BLOCKED_ATTACHMENTS, true, 'privacy_attachment_blocked'],
    ['PDF', { mediaType: 'application/pdf', data: png }, allow, true, 'privacy_attachment_blocked'],
    ['audio', { mediaType: 'audio/webm', data: png }, allow, true, 'privacy_attachment_blocked'],
    ['SVG (scriptable text)', { mediaType: 'image/svg+xml', data: png }, allow, true, 'privacy_attachment_blocked'],
    ['remote URL', { mediaType: 'image/png', data: new URL('https://example.invalid/a.png') }, allow, true, 'privacy_attachment_blocked'],
    ['remote URL string', { mediaType: 'image/png', data: 'https://example.invalid/a.png' }, allow, true, 'privacy_attachment_blocked'],
    ['non-vision model', { mediaType: 'image/png', data: png }, allow, false, 'provider_capability_missing'],
  ] as const)('withholds %s', (_label, part, policy, vision, code) => {
    expect(attachmentDecision(part, policy, vision)).toEqual({ allowed: false, code });
  });
});

describe('status text', () => {
  it('names the unprotected screenshot path explicitly', () => {
    expect(screenshotStatusText(resolveAttachmentPolicy({ app: 'allow-original' }))).toBe('Text geschützt; Screenshots werden im Original übertragen');
    expect(screenshotStatusText(BLOCKED_ATTACHMENTS, 'en')).toBe('Text protected; screenshots are blocked');
  });
});
