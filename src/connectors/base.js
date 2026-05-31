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

  list() {
    return [...this.connectors.values()].map((connector) => ({
      source: connector.source,
      configured: connector.isConfigured(),
      practical: connector.practical,
      description: connector.description,
      requirements: typeof connector.requirements === 'function' ? connector.requirements() : [],
    }));
  }

  async readiness(source = '') {
    const connectors = source ? [this.get(source)] : [...this.connectors.values()];
    return Promise.all(connectors.map(async (connector) => {
      const base = {
        source: connector.source,
        configured: connector.isConfigured(),
        practical: connector.practical,
        requirements: typeof connector.requirements === 'function' ? connector.requirements() : [],
      };
      if (!connector.isConfigured()) {
        return { ...base, ready: false, status: 'missing_configuration' };
      }
      if (typeof connector.checkReadiness !== 'function') {
        return { ...base, ready: true, status: 'configured' };
      }
      try {
        const result = await connector.checkReadiness();
        return { ...base, ready: Boolean(result.ready), status: result.status || 'checked', details: result.details || {} };
      } catch (error) {
        return { ...base, ready: false, status: 'check_failed', error: error.message };
      }
    }));
  }
}

export async function runConnectorSync({ connector, tenantId, userId, store, searchEngine, options = {} }) {
  const documents = await connector.sync({ tenantId, userId, store, options });
  const indexed = await searchEngine.indexDocuments(documents, { chunker: createChunks });
  await store.save();
  return { documents, indexed };
}

export function checkpointKey(source, tenantId, userId, name) {
  return `${source}:${tenantId}:${userId}:${name}`;
}
