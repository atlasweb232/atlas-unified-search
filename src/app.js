import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantActionService } from './assistant/actions.js';
import { LocalArtifactProvider } from './assistant/artifacts.js';
import { createChatProvider } from './assistant/providers.js';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { requireApiAuth } from './middleware/auth.js';
import { createJobQueue } from './queue/serviceBusQueue.js';
import { parseSyncSchedules, summarizeSchedules } from './scheduleConfig.js';
import { SearchRunCoordinator } from './searchRun.js';
import { createSearchStore } from './stores/postgresStore.js';
import { SearchEngine } from './store.js';

export async function createApp(config) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));
  app.use(requireApiAuth(config));

  const store = await createSearchStore(config);
  await store.load();
  const embedder = await createEmbedder(config);
  const searchEngine = new SearchEngine({ store, embedder });
  const registry = createConnectorRegistry(config);
  const queue = createJobQueue(config);
  const jobs = new JobRunner({ registry, store, searchEngine, queue });
  const searchRuns = new SearchRunCoordinator({ store, searchEngine, registry, sourceTimeoutMs: config.searchRun?.sourceTimeoutMs });
  const assistant = new AssistantActionService({
    store,
    chatProvider: createChatProvider(config),
    artifactProvider: new LocalArtifactProvider({ dataDir: config.dataDir, azure: config.artifacts || {} }),
  });

  app.locals.services = { store, searchEngine, registry, jobs, searchRuns, assistant, queue };

  app.get('/v1/health', (req, res) => {
    refreshStore(store).then(() => {
    res.json({
      success: true,
      service: 'atlas-unified-search',
      embedding: { model: embedder.model, version: embedder.version },
      index: publicIndexStatus(store.status()),
      auth: { required: Boolean(config.auth?.required) },
      queue: { backend: queue.name },
      schedules: scheduleStatus(config),
      artifacts: { backend: assistant.artifactProvider.name, configured: assistant.artifactProvider.configured() },
    });
    }).catch((error) => res.status(503).json({ success: false, error: error.message }));
  });

  app.get('/v1/connectors', (req, res) => {
    res.json({ success: true, connectors: registry.list() });
  });

  app.get('/v1/connectors/readiness', async (req, res) => {
    try {
      const checks = await registry.readiness(req.query.source || '');
      res.json({ success: true, checks });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/connectors/setup', async (req, res) => {
    try {
      const checks = await registry.readiness(req.query.source || '');
      res.json({ success: true, setup: connectorSetupGuide(checks) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/production-readiness', async (req, res) => {
    try {
      await refreshStore(store);
      const connectorChecks = await registry.readiness();
      const report = productionReadinessReport({
        config,
        store,
        queue,
        assistant,
        connectorChecks,
      });
      res.status(report.readyForProductionTesting ? 200 : 503).json({ success: true, report });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/index/status', async (req, res) => {
    const { tenantId, userId } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    return res.json({ success: true, index: store.scopedStatus({ tenantId, userId }) });
  });

  app.post('/v1/sync/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      await requireReadyConnector(registry, req.params.source, options);
      const job = await jobs.enqueue({ source: req.params.source, tenantId, userId, options, autoStart: !wait });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options });
        return res.json({ success: true, job: result.job, indexed: result.indexed });
      }
      return res.status(202).json({ success: true, job });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/events/:source', async (req, res) => {
    const { tenantId, userId, event = {}, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      const eventOptions = connectorEventOptions(req.params.source, event, options);
      await requireReadyConnector(registry, req.params.source, eventOptions);
      await refreshStore(store);
      store.audit({
        eventType: 'connector_event_received',
        tenantId,
        userId,
        source: req.params.source,
        metadata: eventOptions.eventTrigger,
      });
      await store.save();
      const job = await jobs.enqueue({ source: req.params.source, tenantId, userId, options: eventOptions, autoStart: !wait });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options: eventOptions });
        return res.json({ success: true, job: result.job, indexed: result.indexed, eventTrigger: eventOptions.eventTrigger });
      }
      return res.status(202).json({ success: true, job, eventTrigger: eventOptions.eventTrigger });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.post('/v1/search', async (req, res) => {
    const { tenantId, userId, query, sources, filters, limit } = req.body || {};
    if (!tenantId || !userId || !query) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, and query are required' });
    }
    try {
      await refreshStore(store);
      const allowedSources = filterAllowedSources(config, tenantId, userId, sources);
      if (hasSourcePermissions(config) && !allowedSources.length) {
        return res.status(403).json({ success: false, error: 'No sources are enabled for this user' });
      }
      const results = await searchEngine.search({ tenantId, userId, query, sources: allowedSources, filters, limit });
      store.audit({ eventType: 'search', tenantId, userId, queryHash: hashQuery(query), metadata: { sources, resultCount: results.length } });
      await store.save();
      return res.json({ success: true, query, results });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/v1/search-runs', async (req, res) => {
    const { tenantId, userId, query, sources, filters, limit, wait = false } = req.body || {};
    if (!tenantId || !userId || !query) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, and query are required' });
    }
    try {
      await refreshStore(store);
      const allowedSources = filterAllowedSources(config, tenantId, userId, sources);
      if (hasSourcePermissions(config) && !allowedSources.length) {
        return res.status(403).json({ success: false, error: 'No sources are enabled for this user' });
      }
      const searchRun = await searchRuns.start({ tenantId, userId, query, sources: allowedSources, filters, limit, wait });
      return res.status(wait ? 200 : 202).json({ success: true, searchRun, results: searchRun.results || [] });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/search-runs/:searchRunId', async (req, res) => {
    await refreshStore(store);
    const searchRun = store.getSearchRun(req.params.searchRunId);
    if (!searchRun) return res.status(404).json({ success: false, error: 'Search run not found' });
    if (!matchesScope(req, searchRun)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, searchRun, results: searchRun.results || [] });
  });

  app.get('/v1/documents/:documentId', async (req, res) => {
    await refreshStore(store);
    const document = store.getDocument(req.params.documentId);
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });
    if (!matchesScope(req, document)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, document });
  });

  app.delete('/v1/documents', async (req, res) => {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    const userId = req.body?.userId || req.query.userId;
    const source = req.body?.source || req.query.source || '';
    const documentIds = req.body?.documentIds || [];
    const resetCheckpoints = Boolean(req.body?.resetCheckpoints || req.query.resetCheckpoints === 'true');
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (source && !sourceAllowed(config, tenantId, userId, source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${source}` });
    }
    await refreshStore(store);
    const deleted = store.deleteDocuments({ tenantId, userId, source, documentIds });
    const checkpoints = resetCheckpoints ? store.deleteCheckpoints({ tenantId, userId, source }) : { deleted: 0 };
    store.audit({ eventType: 'documents_delete', tenantId, userId, source, metadata: { deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted } });
    await store.save();
    return res.json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, documentIds: deleted.documentIds });
  });

  app.post('/v1/reindex/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      await requireReadyConnector(registry, req.params.source, options);
      await refreshStore(store);
      const deleted = store.deleteDocuments({ tenantId, userId, source: req.params.source });
      const checkpoints = store.deleteCheckpoints({ tenantId, userId, source: req.params.source });
      store.audit({ eventType: 'reindex_start', tenantId, userId, source: req.params.source, metadata: { deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted } });
      await store.save();
      const job = await jobs.enqueue({
        source: req.params.source,
        tenantId,
        userId,
        options: { ...options, forceFullSync: true },
        autoStart: !wait,
      });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options: { ...options, forceFullSync: true } });
        return res.json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job: result.job, indexed: result.indexed });
      }
      return res.status(202).json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details || undefined });
    }
  });

  app.get('/v1/jobs', async (req, res) => {
    const { tenantId, userId } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    res.json({ success: true, jobs: jobs.listJobs({ tenantId, userId }) });
  });

  app.get('/v1/audit', async (req, res) => {
    const { tenantId, userId, eventType = '', limit = '100' } = req.query || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    await refreshStore(store);
    const events = store.listAudit({ tenantId, userId, eventType, limit });
    return res.json({ success: true, events });
  });

  app.post('/v1/assistant/actions', async (req, res) => {
    const { tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider } = req.body || {};
    if (!tenantId || !userId || !searchRunId || !actionType || !selectedResultIds?.length) {
      return res.status(400).json({ success: false, error: 'tenantId, userId, searchRunId, actionType, and selectedResultIds are required' });
    }
    try {
      await refreshStore(store);
      const actionJob = await assistant.run({ tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider });
      return res.status(actionJob.status === 'failed' ? 500 : 202).json({ success: actionJob.status !== 'failed', actionJob });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/assistant/actions/:actionJobId', async (req, res) => {
    await refreshStore(store);
    const actionJob = store.getAssistantAction(req.params.actionJobId);
    if (!actionJob) return res.status(404).json({ success: false, error: 'Assistant action not found' });
    if (!matchesScope(req, actionJob)) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, actionJob });
  });

  const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  return app;
}

async function refreshStore(store) {
  if (typeof store.refresh !== 'function') return;
  if (typeof store.withStoreLock === 'function') {
    await store.withStoreLock(() => store.refresh());
    return;
  }
  await store.refresh();
}

async function requireReadyConnector(registry, source, options = {}) {
  if (options.fixtures) return;
  const [check] = await registry.readiness(source);
  if (check?.ready) return;
  const missing = (check?.requirements || [])
    .filter((requirement) => !requirement.configured && !requirement.optional)
    .map((requirement) => requirement.name);
  const error = new Error(`Connector is not ready: ${source}`);
  error.statusCode = 409;
  error.details = {
    source,
    status: check?.status || 'not_reported',
    missing,
    error: check?.error,
  };
  throw error;
}

function matchesScope(req, row) {
  const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
  const userId = req.query.userId || req.headers['x-user-id'];
  return Boolean(tenantId && userId && row.tenantId === tenantId && row.userId === userId);
}

function publicIndexStatus(status) {
  return {
    backend: status.backend,
    ready: ['postgres-pgvector', 'json'].includes(status.backend),
  };
}

function connectorEventOptions(source, event = {}, options = {}) {
  const trigger = eventTriggerSummary(source, event);
  const { fixtures: _fixtures, ...safeOptions } = options || {};
  const base = { ...safeOptions, eventTrigger: trigger };
  if (source === 'slack') {
    return {
      ...base,
      ...(event.channel ? { channelIds: [event.channel] } : {}),
      ...(event.ts || event.event_ts ? { sinceTs: event.thread_ts || event.ts || event.event_ts } : {}),
      limit: options.limit || 50,
    };
  }
  if (source === 'google_drive') {
    return {
      ...base,
      ...(event.folderIds?.length ? { folderIds: event.folderIds } : {}),
      ...(event.modifiedTime ? { modifiedAfter: event.modifiedTime } : {}),
      limit: options.limit || 50,
    };
  }
  if (source === 'conference_bridge') {
    return {
      ...base,
      ...(event.prefix || event.blobPrefix ? { prefix: event.prefix || event.blobPrefix } : {}),
    };
  }
  if (source === 'data_fabric') {
    return {
      ...base,
      ...(event.dataset ? { dataset: event.dataset } : {}),
      limit: options.limit || 50,
    };
  }
  return base;
}

function eventTriggerSummary(source, event = {}) {
  return {
    source,
    eventType: event.type || event.eventType || 'connector_event',
    eventId: event.event_id || event.eventId || event.id || '',
    receivedAt: new Date().toISOString(),
    channelId: event.channel || '',
    fileId: event.fileId || event.file_id || '',
    resourceId: event.resourceId || event.resource_id || '',
    dataset: event.dataset || '',
    prefix: event.prefix || event.blobPrefix || '',
  };
}

function hashQuery(query) {
  let hash = 0;
  for (const char of String(query || '')) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return `q_${Math.abs(hash)}`;
}

function filterAllowedSources(config, tenantId, userId, sources = []) {
  const selected = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!hasSourcePermissions(config)) return selected;
  if (!selected.length) return allowedSourcesFor(config, tenantId, userId);
  return selected.filter((source) => sourceAllowed(config, tenantId, userId, source));
}

function sourceAllowed(config, tenantId, userId, source) {
  const permissions = config.sourcePermissions || {};
  if (!hasSourcePermissions(config)) return true;
  const candidates = [
    `${tenantId}:${userId}`,
    `${tenantId}:*`,
    `*:${userId}`,
    '*:*',
  ];
  for (const key of candidates) {
    const allowed = permissions[key];
    if (Array.isArray(allowed)) return allowed.includes(source) || allowed.includes('*');
  }
  return false;
}

function allowedSourcesFor(config, tenantId, userId) {
  const permissions = config.sourcePermissions || {};
  const candidates = [
    `${tenantId}:${userId}`,
    `${tenantId}:*`,
    `*:${userId}`,
    '*:*',
  ];
  for (const key of candidates) {
    const allowed = permissions[key];
    if (Array.isArray(allowed)) return allowed;
  }
  return [];
}

function hasSourcePermissions(config) {
  return Boolean(config.sourcePermissions && Object.keys(config.sourcePermissions).length);
}

function productionReadinessReport({ config, store, queue, assistant, connectorChecks }) {
  const checksBySource = Object.fromEntries(connectorChecks.map((check) => [check.source, check]));
  const infrastructure = {
    apiAuth: { ready: Boolean(config.auth?.required), detail: config.auth?.required ? 'required' : 'not_required' },
    index: { ready: store.status().backend === 'postgres-pgvector', detail: store.status().backend },
    queue: { ready: queue.name === 'azure-service-bus', detail: queue.name },
    artifacts: { ready: assistant.artifactProvider.name === 'azure-blob-artifact' && assistant.artifactProvider.configured(), detail: assistant.artifactProvider.name },
    scheduler: scheduleStatus(config),
  };
  const liveSources = ['email', 'conference_bridge', 'knowledge_base']
    .map((source) => ({ source, ready: Boolean(checksBySource[source]?.ready), status: checksBySource[source]?.status || 'not_reported' }));
  const credentialBlockedSources = ['slack', 'google_drive']
    .filter((source) => !checksBySource[source]?.ready)
    .map((source) => ({
      source,
      status: checksBySource[source]?.status || 'not_reported',
      missing: (checksBySource[source]?.requirements || [])
        .filter((requirement) => !requirement.configured && !requirement.optional)
        .map((requirement) => requirement.name),
    }));
  const liveButExternal = ['slack', 'google_drive']
    .filter((source) => checksBySource[source]?.ready)
    .map((source) => ({ source, status: checksBySource[source].status }));
  const futureSources = ['data_fabric']
    .map((source) => ({ source, ready: Boolean(checksBySource[source]?.ready), status: checksBySource[source]?.status || 'not_reported' }));
  const fixtureOnly = [
    {
      source: 'slack',
      status: 'fixture_pipeline_only_until_live_readiness',
      proves: ['normalization shape', 'Service Bus worker path', 'Postgres/pgvector indexing', 'search', 'assistant artifacts'],
      doesNotProve: ['Slack token validity', 'Slack channel access', 'Slack history/thread/file API calls'],
    },
    {
      source: 'google_drive',
      status: 'fixture_tests_only_until_live_readiness',
      proves: ['document shape', 'index/search behavior'],
      doesNotProve: ['Google OAuth/service account validity', 'Drive file listing/export/download'],
    },
  ];
  const infrastructureReady = Object.values(infrastructure).every((item) => item.ready);
  const requiredLiveSourcesReady = liveSources.every((item) => item.ready);
  return {
    generatedAt: new Date().toISOString(),
    readyForProductionTesting: infrastructureReady && requiredLiveSourcesReady,
    productionComplete: infrastructureReady && requiredLiveSourcesReady && credentialBlockedSources.length === 0 && futureSources.every((item) => item.ready),
    infrastructure,
    liveSources,
    liveButExternal,
    credentialBlockedSources,
    futureSources,
    fixtureOnly,
    nextActions: [
      ...(credentialBlockedSources.some((item) => item.source === 'slack') ? ['Configure SLACK_BOT_TOKEN and SLACK_CHANNEL_IDS, then run /v1/reindex/slack with a real channel.'] : []),
      ...(credentialBlockedSources.some((item) => item.source === 'google_drive') ? ['Configure Google OAuth refresh token or service account, then run /v1/reindex/google_drive with a real folder.'] : []),
      ...(futureSources.some((item) => item.source === 'data_fabric' && !item.ready) ? ['Define and configure the Data Fabric API contract before claiming live Data Fabric readiness.'] : []),
    ],
  };
}

function scheduleStatus(config) {
  try {
    const schedules = parseSyncSchedules(config.syncSchedulesRaw || '');
    return {
      ready: schedules.length > 0 || !config.schedulerRequired,
      detail: schedules.length ? 'configured' : 'not_configured_manual_only',
      required: Boolean(config.schedulerRequired),
      schedules: summarizeSchedules(schedules),
    };
  } catch (error) {
    return {
      ready: false,
      detail: 'invalid_configuration',
      error: error.message,
      schedules: [],
    };
  }
}

function connectorSetupGuide(checks) {
  return checks.map((check) => {
    const missing = check.ready ? [] : (check.requirements || [])
      .filter((requirement) => !requirement.configured && !requirement.optional)
      .filter((requirement) => !requirement.recommended)
      .map((requirement) => requirement.name);
    const base = {
      source: check.source,
      ready: Boolean(check.ready),
      status: check.status,
      missing,
      requirements: check.requirements || [],
      vectorizationMode: check.vectorizationMode || 'local_index',
      vectorizationBoundary: vectorizationBoundary(check.source, check.vectorizationMode || 'local_index'),
      nextAction: setupNextAction(check.source, missing, check),
      liveSmoke: liveSmokeGuide(check.source),
    };
    return base;
  });
}

function vectorizationBoundary(source, mode) {
  if (source === 'email' && mode === 'external_federated') {
    return 'Email search is federated into the existing Atlas email vector service; unified search does not create or store email embeddings for this path.';
  }
  return 'This connector is indexed and vectorized inside unified search for the tenant/user scope used by sync or reindex jobs.';
}

function setupNextAction(source, missing, check) {
  if (check.ready) {
    return 'Run production smoke reindex/search for this connector with a small known-readable scope.';
  }
  if (source === 'slack') {
    return missing.length
      ? 'Install the Slack app, invite the bot to at least one channel, then wire SLACK_BOT_TOKEN and SLACK_CHANNEL_IDS into both Container Apps.'
      : 'Slack configuration exists but readiness failed; verify bot scopes and channel membership.';
  }
  if (source === 'google_drive') {
    return missing.length
      ? 'Create Google Drive OAuth refresh-token or service-account credentials, grant file/folder access, then wire the Google secret set into both Container Apps.'
      : 'Google Drive configuration exists but readiness failed; verify consent, refresh token validity, service-account sharing, and Drive API access.';
  }
  if (source === 'data_fabric') {
    return missing.includes('DATA_FABRIC_BASE_URL')
      ? 'Deploy or identify the Data Fabric HTTP service and wire DATA_FABRIC_BASE_URL into both Container Apps.'
      : 'Data Fabric configuration exists but readiness failed; verify /health and /records contract responses.';
  }
  if (source === 'conference_bridge') {
    return 'Wire AZURE_STORAGE_CONNECTION_STRING and CONFERENCE_BLOB_CONTAINERS, then run the conference bridge live smoke.';
  }
  if (source === 'knowledge_base') {
    return 'Wire KNOWLEDGE_BASE_ROOT to a mounted or image-bundled docs root, then run the knowledge base live smoke.';
  }
  if (source === 'email') {
    return 'Wire EMAIL_VECTOR_SEARCH_URL and EMAIL_READINESS_USER_EMAIL to the Atlas email backend, then run email readiness and search smoke.';
  }
  return 'Configure required connector settings and run readiness.';
}

function liveSmokeGuide(source) {
  const guides = {
    slack: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS', 'UNIFIED_SEARCH_SMOKE_SLACK_QUERY'],
    },
    google_drive: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_GDRIVE_FOLDER_IDS', 'UNIFIED_SEARCH_SMOKE_GDRIVE_QUERY'],
    },
    data_fabric: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET', 'UNIFIED_SEARCH_SMOKE_DATA_FABRIC_QUERY'],
    },
    conference_bridge: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: ['UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX'],
    },
    knowledge_base: {
      command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: [],
    },
    email: {
      command: 'npm run smoke:production:ui && UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production',
      env: [],
    },
  };
  return guides[source] || { command: 'UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production', env: [] };
}
