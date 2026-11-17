# Prisma store (PostgreSQL)

Copy the model into `schema.prisma`, run `prisma migrate dev` (or the app's
migration workflow), then copy the store into the app, for example
`src/lib/glirastes/memory-store.ts`. The columns are those of
[sql-schema.md](sql-schema.md).

## Contents

- Model
- Store
- Use

## Model

```prisma
model GlirastesMemoryNote {
  id        String   @id
  scopeKind String   @map("scope_kind")
  scopeKey  String   @map("scope_key")
  content   String
  authorId  String?  @map("author_id")
  createdAt DateTime @default(dbgenerated("clock_timestamp()")) @map("created_at") @db.Timestamptz(6)

  @@index([scopeKind, scopeKey, createdAt], map: "glirastes_memory_notes_scope_idx")
  @@map("glirastes_memory_notes")
}
```

`dbgenerated("clock_timestamp()")` and `Timestamptz(6)` keep the order of notes
added in quick succession; the database sorts, the client never does. Add the
`check (scope_kind in ('user', 'shared'))` of `sql-schema.md` in the migration
SQL when you want the database to enforce it.

## Store

```ts
import type { PrismaClient } from '@prisma/client';
import type { MemoryEntry, MemoryScope, MemoryStore } from 'glirastes/server/nextjs';

type Row = { id: string; content: string; authorId: string | null; createdAt: Date };

const toEntry = (row: Row): MemoryEntry => ({
  id: row.id,
  content: row.content,
  ...(row.authorId ? { authorId: row.authorId } : {}),
  createdAt: row.createdAt.toISOString(),
});

const where = (scope: MemoryScope) => ({ scopeKind: scope.kind, scopeKey: scope.key });

export function createPrismaMemoryStore(prisma: Pick<PrismaClient, 'glirastesMemoryNote'>): MemoryStore {
  const notes = prisma.glirastesMemoryNote;
  return {
    async list(scope) {
      const rows = await notes.findMany({ where: where(scope), orderBy: { createdAt: 'asc' } });
      return rows.map(toEntry);
    },
    async add(scope, note) {
      const row = await notes.create({
        data: {
          id: globalThis.crypto.randomUUID(),
          ...where(scope),
          content: note.content,
          authorId: note.authorId ?? null,
        },
      });
      return toEntry(row);
    },
    async remove(scope, id) {
      const { count } = await notes.deleteMany({ where: { id, ...where(scope) } });
      return count > 0;
    },
  };
}
```

## Use

```ts
import { prisma } from '@/lib/prisma';
import { createPrismaMemoryStore } from '@/lib/glirastes/memory-store';

const memoryStore = createPrismaMemoryStore(prisma);
// memory: { user: { store: memoryStore }, shared: { store: memoryStore }, scope }
```

A Prisma client that was extended or generated to another path: import its
`PrismaClient` type from there instead. Test the store with
[store-test.md](store-test.md).
