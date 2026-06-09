# Feature Spec: Connector Popup UX And Vectorization Observability

## Summary

Replace the detached Slack and Google sign-in controls and oversized connector
maintenance cards with a consistent connector-button interface. OAuth must run
in a popup anchored to the search workspace. Each source reports connected or
connection-failed status, and authenticated users can inspect background
vectorization jobs, index counts, and recent audit events.

## Functional Requirements

1. Render equal-sized source buttons for Email, Slack, Google Drive,
   Conference Bridge, Knowledge Base, and Data Fabric.
2. Remove the detached global Slack and Google sign-in buttons.
3. Open Slack and Google OAuth in a centered popup. The underlying search page
   remains open and receives the OAuth token and scope through `postMessage`.
4. Show `Connected` in green or `Connection failed` in red at the bottom of
   each source button.
5. Show sync, reindex, and delete controls only for connected sources.
6. Poll scoped index status, jobs, and audit endpoints while authenticated and
   render a compact vectorization activity log.
7. Search results show source icon, sender, timestamp, one-line summary, and
   relevance percentage before expansion.
8. Expanding a result shows the full retrieved message and thread/context
   children.
9. Summarize runs against the retrieved result set and renders the completed
   summary in the Assistant panel.

## Acceptance Criteria

- OAuth does not navigate the main workspace away from search.
- Popup success updates tenant, user, token, connectors, and vector logs.
- Popup close or OAuth error produces visible failed status.
- Vector activity shows real scoped job status and indexed document/chunk
  counts.
- Slack result cards satisfy the requested compact and expanded layouts.
- Production build and frontend browser smoke tests pass.
