import { createDocument, oneLine, SOURCES } from '../model.js';

export class DataFabricConnector {
  constructor(config) {
    this.source = SOURCES.dataFabric;
    this.config = config.dataFabric;
    this.practical = false;
    this.description = 'Data fabric connector placeholder for future structured operational data search.';
  }

  isConfigured() {
    return Boolean(this.config.baseUrl);
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => fabricFixtureToDocument({ tenantId, userId, item }));
    throw new Error('Data fabric connector is not implemented for live sync yet');
  }
}

function fabricFixtureToDocument({ tenantId, userId, item }) {
  return createDocument({
    tenantId,
    userId,
    source: SOURCES.dataFabric,
    sourceId: item.id,
    sourceUri: item.uri || '',
    title: item.title,
    summary: item.summary || oneLine(item.text || JSON.stringify(item.record || {})),
    body: item.text || JSON.stringify(item.record || {}, null, 2),
    author: item.owner || 'data-fabric',
    timestamp: item.timestamp || new Date().toISOString(),
    container: item.dataset || 'data-fabric',
    metadata: item.metadata || { record: item.record || {} },
  });
}
