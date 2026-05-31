import cors from 'cors';
import express from 'express';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { JsonSearchStore, SearchEngine } from './store.js';

export async function createApp(config) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));

  const store = new JsonSearchStore({ dataDir: config.dataDir });
  await store.load();
  const embedder = await createEmbedder(config);
  const searchEngine = new SearchEngine({ store, embedder });
  const registry = createConnectorRegistry(config);
  const jobs = new JobRunner({ registry, store, searchEngine });

  app.locals.services = { store, searchEngine, registry, jobs };

  app.get('/v1/health', (req, res) => {
    res.json({
      success: true,
      service: 'atlas-unified-search',
      embedding: { model: embedder.model, version: embedder.version },
      index: store.status(),
      connectors: registry.list(),
    });
  });

  app.get('/v1/connectors', (req, res) => {
    res.json({ success: true, connectors: registry.list() });
  });

  app.post('/v1/sync/:source', async (req, res) => {
    const { tenantId, userId, options = {}, wait = false } = req.body || {};
    if (!tenantId || !userId) {
      return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
    }
    try {
      const job = await jobs.enqueue({ source: req.params.source, tenantId, userId, options });
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
      const results = await searchEngine.search({ tenantId, userId, query, sources, filters, limit });
      store.audit({ eventType: 'search', tenantId, userId, queryHash: hashQuery(query), metadata: { sources, resultCount: results.length } });
      await store.save();
      return res.json({ success: true, query, results });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/v1/documents/:documentId', (req, res) => {
    const document = store.getDocument(req.params.documentId);
    if (!document) return res.status(404).json({ success: false, error: 'Document not found' });
    return res.json({ success: true, document });
  });

  app.get('/v1/jobs', (req, res) => {
    res.json({ success: true, jobs: jobs.listJobs() });
  });

  return app;
}

function hashQuery(query) {
  let hash = 0;
  for (const char of String(query || '')) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return `q_${Math.abs(hash)}`;
}
