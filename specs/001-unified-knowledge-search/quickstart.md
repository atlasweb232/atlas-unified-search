# Quickstart Draft

```bash
npm install
cp .env.example .env
npm run dev
```

Personal Slack-only first run:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_IDS=C0123,C0456
npm run sync:slack
npm run dev
```

Future source config:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AZURE_STORAGE_CONNECTION_STRING=...
CONFERENCE_BLOB_CONTAINERS=conference-transcripts
EMAIL_CONNECTOR_BASE_URL=https://...
POSTGRES_CONNECTION_STRING=postgres://...
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=...
```

Embed widget target:

```jsx
import { UnifiedSearchWidget } from '@atlas/unified-search-widget';

<UnifiedSearchWidget
  apiBaseUrl="https://atlas-unified-search.example.com"
  tenantId={tenantId}
  userId={userId}
/>
```
