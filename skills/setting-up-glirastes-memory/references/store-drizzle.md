# Drizzle store (PostgreSQL)

Copy into the app, for example `src/lib/glirastes/memory-store.ts`, next to the
table of [sql-schema.md](sql-schema.md). Add the table to the app's Drizzle
schema and migrate it with the app's usual workflow (`drizzle-kit generate` or
`push`). The store takes any Drizzle PostgreSQL database (`node-postgres`,
`postgres-js`, `neon-http`, ...).

## Contents

- Table
- Store
- Use

## Table

```ts
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const memoryNotes = pgTable(
  'glirastes_memory_notes',
  {
    id: text('id').primaryKey(),
    scopeKind: text('scope_kind', { enum: ['user', 'shared'] }).notNull(),
    scopeKey: text('scope_key').notNull(),
    content: text('content').notNull(),
    authorId: text('author_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [index('glirastes_memory_notes_scope_idx').on(table.scopeKind, table.scopeKey, table.createdAt)],
);
```

The schema also needs the check constraint of `sql-schema.md`; Drizzle can
declare it with `check(...)`, or leave it to the `enum` type of the column.

## Store

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { MemoryEntry, MemoryScope, MemoryStore } from 'glirastes/server/nextjs';
import { memoryNotes } from './schema';

type Row = typeof memoryNotes.$inferSelect;

const toEntry = (row: Row): MemoryEntry => ({
  id: row.id,
  content: row.content,
  ...(row.authorId ? { authorId: row.authorId } : {}),
  createdAt: row.createdAt.toISOString(),
});

const inScope = (scope: MemoryScope) =>
  and(eq(memoryNotes.scopeKind, scope.kind), eq(memoryNotes.scopeKey, scope.key));

export function createDrizzleMemoryStore(db: PgDatabase<PgQueryResultHKT>): MemoryStore {
  return {
    async list(scope) {
      const rows = await db
        .select()
        .from(memoryNotes)
        .where(inScope(scope))
        .orderBy(asc(memoryNotes.createdAt));
      return rows.map(toEntry);
    },
    async add(scope, note) {
      const [row] = await db
        .insert(memoryNotes)
        .values({
          id: globalThis.crypto.randomUUID(),
          scopeKind: scope.kind,
          scopeKey: scope.key,
          content: note.content,
          authorId: note.authorId ?? null,
        })
        .returning();
      if (!row) throw new Error('memory note was not stored');
      return toEntry(row);
    },
    async remove(scope, id) {
      const removed = await db
        .delete(memoryNotes)
        .where(and(inScope(scope), eq(memoryNotes.id, id)))
        .returning({ id: memoryNotes.id });
      return removed.length > 0;
    },
  };
}
```

## Use

```ts
import { db } from '@/db';
import { createDrizzleMemoryStore } from '@/lib/glirastes/memory-store';

const memoryStore = createDrizzleMemoryStore(db);
// memory: { user: { store: memoryStore }, shared: { store: memoryStore }, scope }
```

One store can serve both scopes: the scope kind is part of every query. Test it
with [store-test.md](store-test.md).
