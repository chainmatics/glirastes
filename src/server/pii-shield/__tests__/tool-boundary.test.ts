import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresRuntimeStore, type PostgresQueryClient } from '../../../runtime/postgres-store.js';
import { createPrivacyBoundary } from '../model-boundary.js';
import { wrapToolsForPrivacy, type ToolReceiptStore } from '../tool-boundary.js';
import { CANARY, CANARY_PATTERN, memoryShield, testScope } from './privacy-fixtures.js';

type Receipt = { status: 'pending' | 'completed' | 'failed'; toolUuid: string; inputFingerprint: string; resultFingerprint: string | null };

/** Same claim semantics as the Postgres runtime store. */
function memoryReceipts(): ToolReceiptStore & { rows: Map<string, Receipt> } {
  const rows = new Map<string, Receipt>();
  const key = (i: { environmentId: string; runId: string; idempotencyKey: string }) => `${i.environmentId}|${i.runId}|${i.idempotencyKey}`;
  const evidence = (input: { idempotencyKey: string }, row: Receipt, claimed: boolean) => ({
    claimed, idempotencyKey: input.idempotencyKey, toolUuid: row.toolUuid, inputFingerprint: row.inputFingerprint,
    status: row.status, result: null, resultFingerprint: row.resultFingerprint, createdAt: new Date(), completedAt: null,
  });
  return {
    rows,
    async claimToolExecution(input) {
      const existing = rows.get(key(input));
      if (existing) {
        if (existing.toolUuid !== input.toolUuid || existing.inputFingerprint !== input.inputFingerprint) throw new Error('mismatch');
        return evidence(input, existing, false);
      }
      const row: Receipt = { status: 'pending', toolUuid: input.toolUuid, inputFingerprint: input.inputFingerprint, resultFingerprint: null };
      rows.set(key(input), row);
      return evidence(input, row, true);
    },
    async completeToolExecution(input) {
      const row = rows.get(key(input));
      if (!row || row.status !== 'pending') throw new Error('not pending');
      row.status = input.status;
      row.resultFingerprint = input.resultFingerprint;
      return evidence(input, row, false);
    },
  };
}

async function setup() {
  const session = await memoryShield().open(testScope());
  await session.registerIdentities([{ id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail }]);
  const boundary = createPrivacyBoundary({ session });
  const fakeEmail = await session.pseudonymizeText(CANARY.colleagueEmail);
  const fakeId = await session.pseudonymizeText(CANARY.colleagueId);
  return { boundary, fakeEmail, fakeId };
}

describe('authorized tool rehydration', () => {
  it('rehydrates pseudonyms to the originals before needsApproval and execute', async () => {
    const { boundary, fakeEmail, fakeId } = await setup();
    const needsApproval = vi.fn(async (_input: unknown) => false);
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => ({ ok: true }));
    const tools = wrapToolsForPrivacy({ send: { needsApproval, execute } }, boundary);
    await tools.send.execute!({ to: fakeEmail, assigneeId: fakeId, note: 'Hallo' }, { toolCallId: 'c1' });
    expect(execute).toHaveBeenCalledWith({ to: CANARY.colleagueEmail, assigneeId: CANARY.colleagueId, note: 'Hallo' }, { toolCallId: 'c1' });
    await (tools.send.needsApproval as (i: unknown) => Promise<boolean>)({ to: fakeEmail });
    expect(needsApproval).toHaveBeenCalledWith({ to: CANARY.colleagueEmail });
  });

  it('a pseudonym of another scope is not rehydrated (it is not an authority)', async () => {
    const { fakeEmail } = await setup();
    const other = createPrivacyBoundary({ session: await memoryShield().open(testScope()) });
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => ({ ok: true }));
    await wrapToolsForPrivacy({ send: { execute } }, other).send.execute!({ to: fakeEmail }, { toolCallId: 'c1' });
    expect(execute).toHaveBeenCalledWith({ to: fakeEmail }, { toolCallId: 'c1' });
  });

  it('turns a thrown error into a content-free privacy error', async () => {
    const { boundary } = await setup();
    const onToolError = vi.fn();
    const tools = wrapToolsForPrivacy({
      send: { execute: async (_input: unknown, _options?: unknown) => { throw new Error(`SMTP rejected ${CANARY.colleagueEmail}`); } },
    }, boundary, { onToolError });
    const error = await tools.send.execute!({}, { toolCallId: 'c1' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'privacy_tool_failed' });
    expect(String((error as Error).message)).not.toMatch(CANARY_PATTERN);
    expect(onToolError).toHaveBeenCalledWith('send', { name: 'Error', code: 'unknown_error' });
  });

  it('leaves tools without execute (client tools) untouched', async () => {
    const { boundary } = await setup();
    const client = { description: 'ui' };
    expect(wrapToolsForPrivacy({ client }, boundary).client).toBe(client);
  });
});

describe('idempotent writes with receipts', () => {
  it('executes a tool call once; a replay of the same call id does not run it again', async () => {
    const { boundary, fakeEmail } = await setup();
    const receipts = memoryReceipts();
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => ({ sent: true }));
    const tools = wrapToolsForPrivacy({ send: { execute } }, boundary, { receipts });
    expect(await tools.send.execute!({ to: fakeEmail }, { toolCallId: 'call-1' })).toEqual({ sent: true });
    expect(await tools.send.execute!({ to: fakeEmail }, { toolCallId: 'call-1' })).toEqual({ success: true, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a timeout leaves the outcome unknown and blocks a blind retry', async () => {
    const { boundary } = await setup();
    const receipts = memoryReceipts();
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => { throw timeout; });
    const tools = wrapToolsForPrivacy({ send: { execute } }, boundary, { receipts });
    await expect(tools.send.execute!({ n: 1 }, { toolCallId: 'call-2' })).rejects.toMatchObject({ code: 'privacy_tool_outcome_unknown' });
    await expect(tools.send.execute!({ n: 1 }, { toolCallId: 'call-2' })).rejects.toMatchObject({ code: 'privacy_tool_outcome_unknown' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a definite failure is recorded and not retried with the same call id', async () => {
    const { boundary } = await setup();
    const receipts = memoryReceipts();
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => { throw new Error('422'); });
    const tools = wrapToolsForPrivacy({ send: { execute } }, boundary, { receipts });
    await expect(tools.send.execute!({ n: 1 }, { toolCallId: 'call-3' })).rejects.toMatchObject({ code: 'privacy_tool_failed' });
    await expect(tools.send.execute!({ n: 1 }, { toolCallId: 'call-3' })).rejects.toMatchObject({ code: 'privacy_tool_failed' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('the receipt holds neither originals nor a digest of them or of the result', async () => {
    const { boundary, fakeEmail } = await setup();
    const receipts = memoryReceipts();
    const tools = wrapToolsForPrivacy({ send: { execute: async (_input: unknown, _options?: unknown) => ({ to: CANARY.colleagueEmail }) } }, boundary, { receipts });
    await tools.send.execute!({ to: fakeEmail }, { toolCallId: 'call-4' });
    const { createHash } = await import('node:crypto');
    const originalDigest = createHash('sha256').update(JSON.stringify({ to: CANARY.colleagueEmail })).digest('hex');
    const dump = JSON.stringify([...receipts.rows.values()]);
    expect(dump).not.toMatch(CANARY_PATTERN);
    expect(dump).not.toContain(originalDigest);
    expect([...receipts.rows.values()][0]!.resultFingerprint).toBe('not-recorded');
  });
});

const url = process.env.GLIRASTES_TEST_POSTGRES_URL;

describe.skipIf(!url)('receipts in the Postgres runtime store', () => {
  let pool: Pool;
  let client: PostgresQueryClient;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    client = { unsafe: async (sql, params) => (await pool.query(sql, params as unknown[] | undefined)).rows };
    await createPostgresRuntimeStore(client).initialize();
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('executes once across two concurrent deliveries of the same tool call', async () => {
    const { boundary, fakeEmail } = await setup();
    const receipts = createPostgresRuntimeStore(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (_input: unknown, _options?: unknown) => { await gate; return { sent: true }; });
    const tools = wrapToolsForPrivacy({ send: { execute } }, boundary, { receipts });
    const first = tools.send.execute!({ to: fakeEmail }, { toolCallId: 'pg-call-1' });
    await new Promise((r) => setTimeout(r, 50));
    const second = tools.send.execute!({ to: fakeEmail }, { toolCallId: 'pg-call-1' }).catch((e: unknown) => e);
    expect(await second).toMatchObject({ code: 'privacy_tool_outcome_unknown' });
    release();
    expect(await first).toEqual({ sent: true });
    expect(await tools.send.execute!({ to: fakeEmail }, { toolCallId: 'pg-call-1' })).toEqual({ success: true, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
