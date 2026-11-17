# Store test

Run the contract check against the real database, not against a mock.
`verifyMemoryStore` writes into two throwaway scopes, checks what the chat
handler relies on and removes what it wrote. Use a development or test
database, never production.

## Contents

- Test
- What the check covers

## Test

```ts
// src/lib/glirastes/memory-store.test.ts
import { describe, expect, it } from 'vitest';
import { verifyMemoryStore } from 'glirastes/server/nextjs';
import { db } from '@/db';
import { createDrizzleMemoryStore } from './memory-store'; // or createPrismaMemoryStore / createSqlMemoryStore

const store = createDrizzleMemoryStore(db);

describe('memory store', () => {
  it('meets the MemoryStore contract', async () => {
    await verifyMemoryStore(store);
  });

  it('keeps the notes of one key away from another key', async () => {
    const run = globalThis.crypto.randomUUID();
    const mine = { kind: 'shared', key: `tenant-a-${run}` } as const;
    const other = { kind: 'shared', key: `tenant-b-${run}` } as const;
    const note = await store.add(mine, { content: 'Invoices are numbered per year.' });
    try {
      expect(await store.list(other)).toEqual([]);
      expect(await store.remove(other, note.id)).toBe(false);
      expect((await store.list(mine)).map((entry) => entry.id)).toEqual([note.id]);
    } finally {
      await store.remove(mine, note.id);
    }
  });
});
```

Swap the import for the store you copied. Run it with the app's test runner
and the test database's connection string.

## What the check covers

`verifyMemoryStore` throws on the first violation of:

- a new scope lists no notes;
- `add` returns a unique, non-empty `id`, the stored `content`, the given
  `authorId` and an ISO `createdAt`;
- `list` returns the notes oldest first;
- the same key under another `kind` is a separate scope;
- `remove` refuses a note of another scope, returns `true` once for a removed
  note and `false` for a missing one.

It does not cover two different keys of the same kind; the second test above
does. Isolation between tenants beyond the key (row level security) is the
app's own test.
