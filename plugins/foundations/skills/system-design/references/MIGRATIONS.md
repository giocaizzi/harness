# Live-data migrations: expand / contract

One deploy per step. Each step is compatible with the code running before and after it, so any step can be rolled back.

Phases: **expand** (add new, nullable or defaulted) -> **backfill** (batched, outside the schema migration) -> **dual-write / dual-read** -> **switch** reads to new -> **contract** (drop old, in a later release).

## Per change type

| Change | Steps |
|---|---|
| Add required column | 1 add nullable (or constant default where the engine does not rewrite the table); 2 code writes it; 3 backfill in batches; 4 verify no NULLs; 5 add `NOT NULL` (on Postgres, a `NOT VALID` check first, then validate) |
| Rename column | 1 add new; 2 dual-write; 3 backfill; 4 read new; 5 stop writing old; 6 drop old |
| Drop column | 1 stop reading; 2 stop writing; 3 deploy; 4 drop in a later release |
| Change type | add a column of the new type, then as rename |
| Add index | build online (`CREATE INDEX CONCURRENTLY`); no long lock |
| Add foreign key / constraint | add `NOT VALID`, validate separately |
| Split / merge table | new table, dual-write, backfill, switch reads, retire old |
| Enum / status value | add the value first, then the code that writes it; never remove while rows hold it |

## Rules

- Never backfill in the same migration as the constraint: it holds the lock for the whole copy.
- Backfill: batches by primary-key range, throttled, resumable, idempotent; watch replication lag.
- Set `lock_timeout` on DDL so it fails fast instead of queueing behind long transactions.
- A merged migration file is immutable; fix forward with a new one.
- Write the rollback for each step before deploying it.
- Verify with a query (counts, NULLs, old/new mismatches) before the next step.
