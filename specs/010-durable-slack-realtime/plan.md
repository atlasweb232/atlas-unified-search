# Implementation Plan

1. Add `connector_installations` and `connector_events` PostgreSQL tables.
2. Add an encrypted installation repository with PostgreSQL and local JSON
   implementations.
3. Persist OAuth installations and use the repository as the connector token
   provider for API and worker processes.
4. Resolve Slack webhook scope by `team_id` and deduplicate by `event_id`.
5. Add a message-level Slack connector path for event-triggered ingestion.
6. Update migration/deployment wiring and add integration coverage.

The existing Service Bus queue remains the production broker. Feature `008`
remains the future high-volume staged pipeline; this feature makes the current
deployment correct and durable now.
