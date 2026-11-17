# Plain SQL store (PostgreSQL)

For an app without an ORM, or with another SQL client. The store needs one
function: a tagged template that runs a parameterized query and returns the
rows. [postgres.js](https://github.com/porsager/postgres) (`postgres`) already
is one; a `pg` pool needs the small adapter below. The table is the one of
[sql-schema.md](sql-schema.md). The queries use `$n` parameters only through
the tag, never string concatenation.

## Contents

- Store
- Tag for `pg`
- Use

## Store

```ts
import type { MemoryEntry, MemoryScope, MemoryStore } from 'glirastes/server/nextjs';

export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<Record<string, unknown>[]>;

type NoteRow = { id: string; content: string; author_id: string | null; created_at: Date };

const toEntry = (row: NoteRow): MemoryEntry => ({
  id: row.id,
  content: row.content,
  ...(row.author_id ? { authorId: row.author_id } : {}),
  createdAt: row.created_at.toISOString(),
});

export function createSqlMemoryStore(sql: SqlTag): MemoryStore {
  return {
    async list(scope: MemoryScope) {
      const rows = await sql`
        select id, content, author_id, created_at
        from glirastes_memory_notes
        where scope_kind = ${scope.kind} and scope_key = ${scope.key}
        order by created_at asc`;
      return (rows as NoteRow[]).map(toEntry);
    },
    async add(scope, note) {
      const rows = await sql`
        insert into glirastes_memory_notes (id, scope_kind, scope_key, content, author_id)
        values (${globalThis.crypto.randomUUID()}, ${scope.kind}, ${scope.key}, ${note.content}, ${note.authorId ?? null})
        returning id, content, author_id, created_at`;
      const row = (rows as NoteRow[])[0];
      if (!row) throw new Error('memory note was not stored');
      return toEntry(row);
    },
    async remove(scope, id) {
      const rows = await sql`
        delete from glirastes_memory_notes
        where id = ${id} and scope_kind = ${scope.kind} and scope_key = ${scope.key}
        returning id`;
      return rows.length > 0;
    },
  };
}
```

The driver must return `created_at` as a `Date` (the default of both `pg` and
postgres.js for `timestamptz`).

## Tag for `pg`

```ts
import { Pool } from 'pg';
import type { SqlTag } from './memory-store';

export function pgTag(pool: Pool): SqlTag {
  return async (strings, ...values) => {
    const text = strings.reduce((query, part, index) => `${query}$${index}${part}`);
    const result = await pool.query(text, values);
    return result.rows;
  };
}
```

A tenant-scoped connection (a `set local` per transaction, row level security)
goes into the tag: acquire the connection and set the tenant there.

## Use

```ts
import { Pool } from 'pg';
import { createSqlMemoryStore } from '@/lib/glirastes/memory-store';
import { pgTag } from '@/lib/glirastes/pg-tag';

const memoryStore = createSqlMemoryStore(pgTag(new Pool({ connectionString: process.env.DATABASE_URL })));
// memory: { user: { store: memoryStore }, shared: { store: memoryStore }, scope }
```

With postgres.js: `createSqlMemoryStore(postgres(process.env.DATABASE_URL!))`.
Test the store with [store-test.md](store-test.md).
