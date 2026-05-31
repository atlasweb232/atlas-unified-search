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
    }));
  }
}

export async function runConnectorSync({ connector, tenantId, userId, store, searchEngine, options = {} }) {
  const documents = await connector.sync({ tenantId, userId, store, options });
  const indexed = await searchEngine.indexDocuments(documents, { chunker: createChunks });
  await store.save();
  return { documents, indexed };
}
