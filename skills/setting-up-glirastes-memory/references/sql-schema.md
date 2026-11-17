# Notes table

One table holds the notes of every scope. It is plain SQL (PostgreSQL); adapt
the types for another database. The ORM templates in this folder
([Drizzle](store-drizzle.md), [Prisma](store-prisma.md), [plain SQL](store-sql.md))
all read and write exactly these columns.

## Contents

- Schema
- Columns
- Tenant isolation
- Deleting notes

## Schema

```sql
create table glirastes_memory_notes (
  id          text primary key,
  scope_kind  text not null check (scope_kind in ('user', 'shared')),
  scope_key   text not null,
  content     text not null,
  author_id   text,
  created_at  timestamptz not null default clock_timestamp()
);

create index glirastes_memory_notes_scope_idx
  on glirastes_memory_notes (scope_kind, scope_key, created_at);
```

## Columns

| Column | Holds |
| --- | --- |
| `id` | the store's note id; the stores generate a UUID in the app, so no database extension is needed |
| `scope_kind` | `user` for a person's own notes, `shared` for the notes of a workspace |
| `scope_key` | the app's key: the user id for `user`, the tenant id for `shared` (what `memory.scope` returns) |
| `content` | the note, one sentence; the handler caps it at 240 characters |
| `author_id` | who the note was written for or by (the `scope().user` key); `null` when unknown |
| `created_at` | insertion time; `list` returns notes oldest first |

`created_at` defaults to `clock_timestamp()` (not `now()`), so two notes
added one after the other always sort in the order they were added.
`verifyMemoryStore` relies on that order.

## Tenant isolation

The store does not know tenants. It filters by `scope_kind` and `scope_key`
only, so isolation comes from the key and from the app's own database rules:

- The key of the `shared` scope must be the tenant id from the verified
  session, never a value from the request. A different key is a different
  scope; there is no way to read "all shared notes".
- An app that enforces tenants with row level security or a tenant-scoped
  connection must run the store inside that context, for example through the
  handler's `wrapHandler`, and add the policy to this table itself. This
  schema carries no tenant column on purpose: a table of `shared` rows keyed
  by tenant id is already partitioned, and the RLS policy belongs to the app.
- Give `user` keys that cannot collide with another tenant's, for example the
  user id when it is globally unique, otherwise `tenantId:userId`.

## Deleting notes

Remove rows when their owner goes away. The queries:

```sql
-- a user is deleted
delete from glirastes_memory_notes where scope_kind = 'user' and scope_key = $1;
-- the notes a deleted user wrote into a shared scope: keep them, drop the name
update glirastes_memory_notes set author_id = null where author_id = $1;
-- a tenant is deleted: its shared notes, and the user notes of its users
delete from glirastes_memory_notes where scope_kind = 'shared' and scope_key = $1;
```

Use the key your `scope` returns in each query, and run them in the same
transaction as the user or tenant deletion.
