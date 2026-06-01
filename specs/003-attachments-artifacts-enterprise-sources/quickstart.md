# Quickstart: Credential-Free End-to-End Demo

Demonstrates the full experience — login → background + delta vectorization →
unified search → ephemeral workbench → summarize / presentation / analytical
report — with **no Slack/Google/Azure/enterprise/LLM account**.

Prereqs: the `002` foundation (local Postgres+pgvector, identity, deterministic
embedder) from `specs/002-.../quickstart.md`.

## 1. Start mocks (stand in for enterprise systems)

```bash
npm run mock:data-fabric           # local Data Fabric HTTP service, seeded
export DATA_FABRIC_BASE_URL=http://localhost:4500
export KNOWLEDGE_BASE_ROOT=$(pwd)/mocks/knowledge-base   # seeded KB corpus
```

## 2. Credential-free config (adds to 002)

```bash
export ARTIFACT_PROVIDER=organic   # real .pptx/.pdf, no API key
# optional: ARTIFACT_PROVIDER=llm + CHAT_PROVIDER=... to use LLM-shaped content
export CHAT_PROVIDER=mock          # summaries/reports without an LLM key
export ATTACHMENT_MAX_BYTES=10485760
```

No `SLACK_*`, `GOOGLE_*`, `AZURE_*`, `OPENAI_*`, `ANTHROPIC_*` needed.

## 3. Index fixtures + mock enterprise data (real path, fake data)

```bash
# Connector fixtures include attachment BYTES (or pre-extracted text) so
# attachment content is extracted, chunked, and embedded.
npm run seed:fixtures
# Index the mock enterprise sources like any other connector:
curl -s localhost:4420/v1/sync/data_fabric   -H "$AUTH" -d '{"tenantId":"t","userId":"u"}'
curl -s localhost:4420/v1/sync/knowledge_base -H "$AUTH" -d '{"tenantId":"t","userId":"u"}'
```

## 4. Search, including inside attachments

```bash
# A term that exists ONLY inside a PDF/docx attachment still returns its parent:
curl -s localhost:4420/v1/search -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","query":"clause buried in the attached contract"}'
```

## 5. Reconstruct the real attachment

```bash
# Pull the original bytes back from the source (never a public URL):
curl -s -OJ localhost:4420/v1/attachments/<attachmentRef>/content -H "$AUTH"
```

## 6. Workbench → summarize / presentation / report

```bash
# Hold selected results in an ephemeral session:
WB=$(curl -s localhost:4420/v1/workbench -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","searchRunIds":["<runId>"]}' | jq -r .session.id)
curl -s localhost:4420/v1/workbench/$WB/selections -H "$AUTH" \
  -d '{"selections":[{"lineItemId":"..."},{"lineItemId":"..."}]}'

# Real PowerPoint:
curl -s localhost:4420/v1/assistant/actions -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","workbenchSessionId":"'$WB'","actionType":"create_powerpoint"}'

# Analytical report (manual sourcing): first search + select Data Fabric and KB
# hits into the workbench, then:
curl -s localhost:4420/v1/assistant/actions -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","workbenchSessionId":"'$WB'","actionType":"create_report"}'
```

The produced `.pptx`/`.pdf` are real, openable files with provenance listing the
included result IDs. The report cites every selected result and attributes each
section to its source (Slack/Drive/email/conference/Data Fabric/KB).

## 7. What still needs real accounts (out of scope)

Live Slack/Google/Azure token validation (`checkReadiness`). The entire `003`
experience is demonstrable without it.
