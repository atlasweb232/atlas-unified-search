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
  const searchRuns = new SearchRunCoordinator({ store, searchEngine, registry });
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
      index: store.status(),
      auth: { required: Boolean(config.auth?.required) },
      queue: { backend: queue.name },
      artifacts: { backend: assistant.artifactProvider.name, configured: assistant.artifactProvider.configured() },
      connectors: registry.list(),
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

  app.post('/v1/sync/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    if (!sourceAllowed(config, tenantId, userId, req.params.source)) {
      return res.status(403).json({ success: false, error: `Source is not enabled for this user: ${req.params.source}` });
    }
    try {
      const job = await jobs.enqueue({ source: req.params.source, tenantId, userId, options, autoStart: !wait });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options });
        return res.json({ success: true, job: store.state.jobs[job.id], indexed: result.indexed });
      }
      return res.status(202).json({ success: true, job });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
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
    await refreshStore(store);
    const deleted = store.deleteDocuments({ tenantId, userId, source: req.params.source });
    const checkpoints = store.deleteCheckpoints({ tenantId, userId, source: req.params.source });
    store.audit({ eventType: 'reindex_start', tenantId, userId, source: req.params.source, metadata: { deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted } });
    await store.save();
    try {
      const job = await jobs.enqueue({
        source: req.params.source,
        tenantId,
        userId,
        options: { ...options, forceFullSync: true },
        autoStart: !wait,
      });
      if (wait) {
        const result = await jobs.run(job.id, { source: req.params.source, tenantId, userId, options: { ...options, forceFullSync: true } });
        return res.json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job: store.state.jobs[job.id], indexed: result.indexed });
      }
      return res.status(202).json({ success: true, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted, job });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted });
    }
  });

  app.get('/v1/jobs', async (req, res) => {
    await refreshStore(store);
    res.json({ success: true, jobs: jobs.listJobs() });
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
  if (typeof store.refresh === 'function') await store.refresh();
}

function matchesScope(req, row) {
  const tenantId = req.query.tenantId || req.headers['x-tenant-id'];
  const userId = req.query.userId || req.headers['x-user-id'];
  return Boolean(tenantId && userId && row.tenantId === tenantId && row.userId === userId);
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
