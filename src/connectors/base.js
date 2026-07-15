import { createChunks } from '../model.js';

export class ConnectorRegistry {
  constructor(connectors) {
    this.connectors = new Map(connectors.map((connector) => [connector.source, connector]));
  }

  get(source) {
    const connector = this.connectors.get(source);
    if (!connector) throw new Error(`Unsupported source: ${source}`);
    return connector;
  }

  list(scope = {}) {
    return [...this.connectors.values()].map((connector) => ({
      source: connector.source,
      configured: connector.isConfigured(scope),
      practical: connector.practical,
      description: connector.description,
      vectorizationMode: connector.vectorizationMode || 'local_index',
      requirements: typeof connector.requirements === 'function' ? connector.requirements(scope) : [],
    }));
  }

  async readiness(source = '', scope = {}) {
    const connectors = source ? [this.get(source)] : [...this.connectors.values()];
    return Promise.all(connectors.map(async (connector) => {
      const base = {
        source: connector.source,
        configured: connector.isConfigured(scope),
        practical: connector.practical,
        vectorizationMode: connector.vectorizationMode || 'local_index',
        requirements: typeof connector.requirements === 'function' ? connector.requirements(scope) : [],
      };
      if (!connector.isConfigured(scope)) {
        return { ...base, ready: false, status: 'missing_configuration' };
      }
      if (typeof connector.checkReadiness !== 'function') {
        return { ...base, ready: true, status: 'configured' };
      }
      try {
        const result = await connector.checkReadiness(scope);
        return { ...base, ready: Boolean(result.ready), status: result.status || 'checked', details: result.details || {} };
      } catch (error) {
        return { ...base, ready: false, status: 'check_failed', error: error.message };
      }
    }));
  }
}

export async function runConnectorSync({ connector, tenantId, userId, store, searchEngine, options = {}, onProgress = null }) {
  const documents = await connector.sync({ tenantId, userId, store, options });
  // Index and flush in chunks so a long sync survives HTTP client headers
  // timeouts (Node fetch defaults to 5 min) and external interruptions —
  // progress is durable, not just held in memory until the end.
  const batchSize = 50;
  let indexed = 0;
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const batch = documents.slice(offset, offset + batchSize);
    indexed += await searchEngine.indexDocuments(batch, { chunker: createChunks });
    await store.save();
    if (onProgress) onProgress({ indexed, total: documents.length, batch: Math.floor(offset / batchSize) + 1 });
  }
  return { documents, indexed };
}

export function checkpointKey(source, tenantId, userId, name) {
  return `${source}:${tenantId}:${userId}:${name}`;
}
