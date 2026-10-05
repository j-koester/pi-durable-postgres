# Deletion windows: running maintenance without an upstream purge API

Pi Durable 1.0.x has no public live-deletion lifecycle (see
[live-deletion.md](live-deletion.md) for why SQL alone is not enough while a
Harness runs). This document describes the host pattern that works **today**
with the maintenance-only `deleteConversation` helper: treat process
restarts as maintenance windows, and make them cheap and idempotent.

## The boot moment is a natural maintenance window

`PostgresStorage.open` takes the advisory ownership lock when the Harness
opens it. Before that, nobody owns the schema. A process that starts, has
not opened a Harness yet, and therefore may run maintenance:

```text
boot
 ├── 1. connect with a fresh pool (nodePostgresDatabase)
 ├── 2. applyPostgresMigrations (idempotent)
 ├── 3. process pending deletion requests   ← maintenance-safe window
 ├── 4. database.close()
 └── 5. Harness.open(openNodePostgresStorage) → advisory lock → resume
```

A crash between steps 3 and 5 is harmless: the next boot processes the same
requests again. Deletion requests must therefore be queued durably outside
the storage itself (a host table), keyed by conversation id.

## Restarts are the cheap part on a durable harness

The usual objection to restart windows — losing in-flight work — does not
apply to a durable harness:

- unfinished tasks resume from their last checkpoint,
- an interrupted tool call reruns only when replay-safe, otherwise the model
  is told it was interrupted,
- queued submissions stay queued; `requestId` dedup prevents double submits.

A restart costs seconds, not user work. Hosts may therefore trigger a
maintenance window **on demand** (restart the owning process) instead of
waiting for a nightly window.

## Host queue semantics

Keep a `deletion_request` table in the host database (not in the durable
storage — it must survive the process and be readable before open):

| field | purpose |
|---|---|
| `conversation_id` | target of `deleteConversation` |
| `status` | `pending` → `done` \| `failed` |
| `requested_by`, `created_at` | audit trail (who asked, when) |
| `done_at`, `error` | settlement and diagnostics |

Processing rules:

1. Mark the target soft-hidden in the host UI immediately on request; the
   durable data follows at the next window.
2. At boot, process `pending` requests oldest first, each with its own
   transaction; one failed request must not block the others.
3. Decide the subtree policy explicitly: `deleteConversation` rejects a
   conversation with attached forks/subagent conversations unless
   `includeForks: true`. DSGVO "delete everything of user X" usually means
   iterating the user's conversations with `includeForks: true`; single
   deletions in shared trees need a review step.
4. Session-scoped documents are never removed by the helper; hosts with
   session documents need their own lifecycle rule.
5. Close the maintenance facade with `database.close()` — never
   `pool.end()` on a facade-wrapped pool (it holds one pinned connection).

## SLA ladder

1. **On demand**: restart the owning process when a deletion request arrives
   (optionally gated on an idle check; a mid-run interruption is survivable).
2. **Scheduled**: a nightly restart guarantees the queue drains even without
   on-demand triggers.
3. **Guaranteed**: every deploy is a restart — the queue can never outlive
   routine deployments.

Document which ladder rung you commit to; for GDPR purposes the chosen
cadence is your "undue delay" definition.

## Related

- [live-deletion.md](live-deletion.md) — the upstream integration design
  that would replace this pattern with a true live lifecycle.
- [README "Conversation deletion: maintenance only"](../README.md) — the
  helper's contract and refusal semantics.
