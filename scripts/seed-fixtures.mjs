const base = process.env.UNIFIED_SEARCH_BASE || 'http://localhost:4420';
const tenantId = process.env.UNIFIED_SEARCH_TENANT_ID || 'atlasweb';
const userId = process.env.UNIFIED_SEARCH_USER_ID || 'local-user';
const authToken = process.env.UNIFIED_SEARCH_AUTH_TOKEN || process.argv[2] || '';
const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {};

const fixtures = {
  slack: [{
    channelId: 'C-ENG',
    channelName: 'engineering',
    timestamp: new Date().toISOString(),
    sender: 'Ada',
    text: 'Deployment failed because the Redis lease was missing.',
    thread: [{ sender: 'Grace', text: 'Added the Redis lease setting and restarted the worker.' }],
    files: [{ name: 'deploy-log.txt', text: 'Redis lease missing in production worker.' }],
  }],
  google_drive: [{
    fileId: 'drive-architecture',
    name: 'Unified Search Architecture',
    owner: 'Rakib',
    text: 'Production unified search uses Azure Service Bus, Postgres pgvector, and source-agent fanout.',
    modifiedTime: new Date().toISOString(),
    folderPath: 'Architecture',
  }],
  email: [{
    id: 'email-calendar',
    subject: 'Calendar endpoint cleanup',
    sender: 'support@atlasweb.info',
    body: 'The LiveKit Sarah calendar endpoint returned 404 and needs route cleanup.',
    receivedAt: new Date().toISOString(),
    attachments: [{ name: 'calendar-error.txt', text: 'GET /api/v1/calendar/events returned 404' }],
  }],
  conference_bridge: [{
    meetingId: 'bridge-launch',
    title: 'Launch bridge',
    organizer: 'Rakib',
    text: 'Discussed Slack and Google Drive background vectorization and tenant segregation.',
    container: 'conference-transcripts',
    segments: [{ speaker: 'Rakib', text: 'Use per-tenant source agents and audit every assistant action.' }],
  }],
  knowledge_base: [{
    id: 'kb-runbook',
    title: 'Unified Search Runbook',
    text: 'If a connector fails, inspect source-agent status and dead-letter queue entries.',
  }],
  data_fabric: [{
    id: 'df-usage',
    title: 'Search Usage Metric',
    text: 'Data fabric reports 42 unified search queries in the pilot tenant.',
    record: { metric: 'unified_search_queries', value: 42 },
  }],
};

// Only seed sources that are actually registered/enabled on the server, so this
// stays in sync with UNIFIED_SEARCH_ENABLED_SOURCES (Phase 1 = email/slack/gdrive).
const connectorsResponse = await fetch(`${base}/v1/connectors`, { headers: authHeaders });
const connectorsData = await connectorsResponse.json();
if (!connectorsResponse.ok || connectorsData.success === false) {
  throw new Error(`connectors: ${connectorsData.error || connectorsResponse.statusText}`);
}
const enabled = new Set((connectorsData.connectors || []).map((connector) => connector.source));

for (const [source, sourceFixtures] of Object.entries(fixtures)) {
  if (!enabled.has(source)) {
    console.log(`${source}: skipped (not enabled)`);
    continue;
  }
  const response = await fetch(`${base}/v1/sync/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ tenantId, userId, wait: true, options: { fixtures: sourceFixtures } }),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(`${source}: ${data.error || response.statusText}`);
  console.log(`${source}: indexed ${data.indexed}`);
}
