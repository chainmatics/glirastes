import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, createApprovalBinder, enforceApprovalBindings } from '../approval-binding.js';

const SECRET = 'binder-v2-secret-with-32-characters!';
const call = { toolCallId: 'call-1', toolName: 'delete_playlist', input: { playlist_id: 7 } };
const subjects = [['playlist', 'target', 'playlist_id', [['playlist_id', '7']], 'named', 'Lobby Loop', null, null]];

/**
 * The verifier of the released v1 format (0.17.x, `approval-binding.ts` before
 * v2), copied verbatim in its decisive steps: an older instance behind the
 * same load balancer runs exactly this on an id it receives.
 */
function releasedV1Verify(secret: string, approvalId: string, input: typeof call): 'ok' | 'approval_not_issued' {
  const prefix = 'glirastes-approval.v1.';
  if (typeof approvalId !== 'string' || !approvalId.startsWith(prefix)) return 'approval_not_issued';
  const [issuedAt, expiresAt, nonce, presented, ...rest] = approvalId.slice(prefix.length).split('.');
  if (!issuedAt || !expiresAt || !nonce || !presented || rest.length > 0) return 'approval_not_issued';
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(['v1', issuedAt, expiresAt, nonce, '', input.toolCallId, input.toolName, canonicalJson(input.input)]))
    .digest();
  const actual = Buffer.from(presented, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'ok' : 'approval_not_issued';
}

describe('approval id v2 (subject digest)', () => {
  it('issues v2 with the subject digest and verifies it', () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const id = binder.issue({ ...call, subjects });
    expect(id).toMatch(/^glirastes-approval\.v2\.\d+\.\d+\.[\w-]{22}\.[\w-]{22}\.[\w-]{43}$/);
    const verified = binder.verify({ ...call, approvalId: id });
    expect(verified).toMatchObject({ ok: true, version: 2, subjectDigest: binder.subjectDigest!(subjects) });
  });

  it('keeps v1 for a call without subjects', () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const id = binder.issue(call);
    expect(id).toMatch(/^glirastes-approval\.v1\./);
    expect(binder.verify({ ...call, approvalId: id })).toMatchObject({ ok: true, version: 1 });
    expect(releasedV1Verify(SECRET, id, call)).toBe('ok');
  });

  it('refuses a v2 id whose digest was changed or which was re-labelled v1', () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const id = binder.issue({ ...call, subjects });
    const parts = id.split('.');
    const otherDigest = binder.subjectDigest!([['playlist', 'target', 'playlist_id', [['playlist_id', '7']], 'named', 'Other', null, null]]);
    expect(binder.verify({ ...call, approvalId: [...parts.slice(0, 5), otherDigest, parts[6]].join('.') })).toEqual({ ok: false, code: 'approval_not_issued' });
    // Without the digest segment, as v1: the MAC was made under the tag v2.
    const asV1 = ['glirastes-approval', 'v1', parts[2], parts[3], parts[4], parts[6]].join('.');
    expect(binder.verify({ ...call, approvalId: asV1 })).toEqual({ ok: false, code: 'approval_not_issued' });
    expect(binder.verify({ ...call, input: { playlist_id: 8 }, approvalId: id })).toEqual({ ok: false, code: 'approval_not_issued' });
  });

  it('is refused by the released v1 verifier by construction, never verified as v1', () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const id = binder.issue({ ...call, subjects });
    expect(releasedV1Verify(SECRET, id, call)).toBe('approval_not_issued');
    // Even a lenient v1 parser that ignored the version would find six segments, not four.
    expect(id.split('.').slice(2)).toHaveLength(5);
  });

  it('refuses a v1 id for a tool that requires the digest (downgrade), in the runnable block and elsewhere', async () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const v1 = binder.issue(call);
    const messages = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        id: 'a', role: 'assistant', parts: [{ type: 'step-start' }, {
          type: 'tool-delete_playlist', toolCallId: 'call-1', state: 'approval-responded', input: call.input,
          approval: { id: v1, approved: true },
        }],
      },
    ];
    const strict = await enforceApprovalBindings(messages, { binder, requiresSubjectDigest: (name) => name === 'delete_playlist' });
    expect(strict.verified).toEqual([]);
    expect(strict.denied).toEqual([{ toolCallId: 'call-1', code: 'approval_not_issued' }]);
    const lenient = await enforceApprovalBindings(messages, { binder });
    expect(lenient.verified).toHaveLength(1);
  });

  it('rechecks before consuming and refuses with the recheck code', async () => {
    const binder = createApprovalBinder({ secret: SECRET });
    const id = binder.issue({ ...call, subjects });
    const consumed: string[] = [];
    const messages = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        id: 'a', role: 'assistant', parts: [{ type: 'step-start' }, {
          type: 'tool-delete_playlist', toolCallId: 'call-1', state: 'approval-responded', input: call.input,
          approval: { id, approved: true },
        }],
      },
    ];
    const seen: unknown[] = [];
    const result = await enforceApprovalBindings(messages, {
      binder,
      store: { consume: (key) => { consumed.push(key); return true; } },
      requiresSubjectDigest: () => true,
      recheck: async (approval) => {
        seen.push(approval.subjectDigest === approval.digestOf(subjects));
        return 'approval_subject_changed';
      },
    });
    expect(seen).toEqual([true]);
    expect(result.denied).toEqual([{ toolCallId: 'call-1', code: 'approval_subject_changed' }]);
    expect(consumed).toEqual([]);
  });
});
