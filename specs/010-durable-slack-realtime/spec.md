# Feature Spec: Durable Slack Realtime Vectorization

## Summary

A Slack workspace installation must survive API restarts and remain usable by
independent workers. Signed Slack Events API deliveries must resolve the
installation by Slack team ID, enqueue an idempotent message-level job, and
upsert the changed message/thread into pgvector without scanning the workspace.

## Functional Requirements

1. Persist Slack installations in PostgreSQL, keyed by Slack team ID and Atlas
   tenant/user scope.
2. Encrypt provider credentials at rest. API responses, logs, jobs, and audit
   events must never expose provider tokens.
3. API and worker processes must resolve credentials from the same durable
   installation repository.
4. OAuth reinstall updates the existing installation and preserves its scope.
5. Route signed Slack events using the payload `team_id`; static global event
   tenant/user settings are fallback-only.
6. Claim Slack `event_id` before enqueue. A repeated delivery is acknowledged
   but does not create another vectorization job.
7. Message events enqueue one message-level task carrying only the event fields
   required to retrieve and normalize that message/thread.
8. The worker embeds and idempotently upserts the affected Slack document and
   chunks into the installation's tenant/user scope.
9. Initial OAuth connection still enqueues a reconciliation backfill.
10. Scheduled/full reconciliation remains available to recover missed events.
11. Connection and event processing status must be visible through existing
    jobs, audit, and index status APIs.

## Acceptance Criteria

- Restarting API and worker containers does not disconnect a Slack installation.
- A worker started after OAuth can resolve the installation without copied env
  variables or local files.
- A signed event from workspace A cannot write to workspace B's Atlas scope.
- Replaying the same Slack `event_id` produces one job and one idempotent
  document upsert.
- A new Slack message appears in scoped pgvector search after event processing.
- Invalid signatures, unknown teams, revoked tokens, and failed jobs are
  observable without leaking credentials.
