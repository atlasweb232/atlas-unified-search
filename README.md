# Atlas Unified Search

Speckit-driven backend and embeddable frontend plan for unified search across:

- Slack messages, threads, links, and attachments
- Google Drive files and exported Google Workspace documents
- conference bridge transcripts/recordings stored in Azure Blob Storage
- current user's email vector index

This repository is intentionally separate from `atlas-emailreact` and
`slack-integration`. The platform should expose a small search API and a React
widget that can be embedded into Atlas Email or used standalone.

Primary feature:

- `specs/001-unified-knowledge-search/spec.md`

Implementation target name:

- `atlas-unified-search`

Related prior repo:

- `https://github.com/atlasweb232/slack-integration`
