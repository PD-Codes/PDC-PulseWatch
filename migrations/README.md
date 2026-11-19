# Database migrations

Files named `NNN_name.sql` are applied in name order by `src/server/db/migrate.ts`, each exactly once, at every start
(all roles; a named lock keeps processes from racing). `schema_migrations` stores the file name and the SHA-256 of its content.

## Rules

1. **Never edit a file that has been released.** The checksum check stops every later start with
   "Migration X was modified after being applied". Fix mistakes with a new file.
2. **Write every statement so that it can run twice.** MariaDB commits DDL immediately, so a file that fails half-way
   leaves its first statements applied, and the file is not recorded as done. With idempotent statements the fix is simply
   to remove the cause and restart; the whole file runs again.
3. One statement per `;`. Statements are executed one by one (so an error names file, statement number and line).
   `DELIMITER` and stored procedures are not supported.
4. Large tables (`heartbeats`, `rollups`, `events`) are changed online: `ALGORITHM=INPLACE, LOCK=NONE`, so heartbeats keep
   being written during the upgrade. If MariaDB cannot do a change in place it fails instead of copying the table silently.
5. Data changes (`UPDATE`, `INSERT`) must give the same result when repeated (guard with `WHERE`, `INSERT IGNORE`,
   `ON DUPLICATE KEY UPDATE`).

## Idempotent forms (MariaDB)

| Change | Write it as |
| --- | --- |
| new table | `CREATE TABLE IF NOT EXISTS t (...)` |
| new column | `ALTER TABLE t ADD COLUMN IF NOT EXISTS c ...` |
| drop column | `ALTER TABLE t DROP COLUMN IF EXISTS c` |
| new index | `ALTER TABLE t ADD INDEX IF NOT EXISTS i (...), ALGORITHM=INPLACE, LOCK=NONE` |
| drop index | `ALTER TABLE t DROP INDEX IF EXISTS i` |
| change a column type | `ALTER TABLE t MODIFY COLUMN c ...` (repeatable as is) |
| new foreign key | `ALTER TABLE t ADD FOREIGN KEY IF NOT EXISTS fk (c) REFERENCES p(id)` |
| rename a column | `ALTER TABLE t RENAME COLUMN IF EXISTS old TO new` |

Files up to `017` predate this convention and are not idempotent; they have been applied everywhere already.

## When a migration failed half-way

The start fails with a message like

```
Migration 020_data.sql failed at statement 2 of 2 (line 10): ER_...: ...
Statements 1-1 of 020_data.sql are already applied ...
```

1. Read the cause (disk full, lock wait, permissions, ...) and fix it.
2. Restart. Idempotent files continue where they stopped.
3. If a statement can only be applied by hand: run the remaining statements yourself, then mark the file as done with the
   `INSERT INTO schema_migrations ...` statement printed in the error (it contains the exact checksum).
