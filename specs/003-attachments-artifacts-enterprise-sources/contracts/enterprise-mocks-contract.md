# Contract: Mock Enterprise Sources

Local, synthetic stand-ins so the analytical-report experience works with no
external enterprise systems or accounts.

## Mock Data Fabric service

Implements the contract the existing `DataFabricConnector` already expects.

### `GET /health`
```text
200 { "ready": true, "service": "mock-data-fabric", "version": "1" }
```

### `GET /records?tenantId=&userId=&dataset=&since=&limit=`
```text
200 { "records": [ Record, ... ] }

Record {
  id
  title
  summary
  text
  record: { ... }          # structured payload (metric/fact/lineage row)
  dataset                  # e.g. 'revenue_metrics' | 'pipeline_facts' | 'lineage'
  timestamp
  uri?                     # optional backend reference (not a public URL)
  metadata?
}
```

- Auth: optional `Authorization: Bearer <DATA_FABRIC_API_TOKEN>` (the mock
  accepts any/none in dev).
- Seeded with **obviously synthetic** records: revenue/usage metrics,
  operational facts, data lineage entries, and operational summaries.
- Start: `npm run mock:data-fabric` (default `http://localhost:4500`).
- Wire: `DATA_FABRIC_BASE_URL=http://localhost:4500`.

## Mock Enterprise Knowledge Base

Consumed by the existing `KnowledgeBaseConnector` via `KNOWLEDGE_BASE_ROOT`.

- A seeded markdown tree under `mocks/knowledge-base/`, organized by space:
  ```text
  runbooks/      policies/      architecture/      faq/
  ```
- Each file has a title + body; folder = `container`/space.
- Synthetic content only (no real PII or proprietary text).
- Wire: `KNOWLEDGE_BASE_ROOT=$(pwd)/mocks/knowledge-base`.

## How they power the report (manual sourcing)

- Both index as normal `SearchDocument`s (`source = data_fabric` /
  `knowledge_base`).
- The user runs a unified search, **selects** Data Fabric and KB hits into the
  workbench alongside Slack/Drive/email/conference results, then requests
  `create_report`. The report fuses and cites exactly those selections.

## Verification (credential-free)

- `npm run mock:data-fabric` + `KNOWLEDGE_BASE_ROOT` let
  `/v1/sync/data_fabric` and `/v1/sync/knowledge_base` index seeded data with no
  external account.
- End-to-end test: search → select cross-source (incl. Data Fabric + KB) →
  `create_report` → cited report containing those sources.
