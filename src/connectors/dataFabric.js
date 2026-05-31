import { createDocument, oneLine, SOURCES } from '../model.js';

export class DataFabricConnector {
  constructor(config) {
    this.source = SOURCES.dataFabric;
    this.config = config.dataFabric;
    this.practical = true;
    this.description = 'Data fabric HTTP connector for structured operational records, metrics, facts, and lineage metadata.';
  }

  isConfigured() {
    return Boolean(this.config.baseUrl);
  }

  requirements() {
    return [
      { name: 'DATA_FABRIC_BASE_URL', configured: Boolean(this.config.baseUrl) },
      { name: 'DATA_FABRIC_API_TOKEN', configured: Boolean(this.config.apiToken), recommended: true },
      { name: 'DATA_FABRIC_READINESS_PATH', configured: Boolean(this.config.readinessPath), optional: true },
      { name: 'DATA_FABRIC_RECORDS_PATH', configured: Boolean(this.config.recordsPath), optional: true },
    ];
  }

  async checkReadiness() {
    const response = await fetch(urlFor(this.config.baseUrl, this.config.readinessPath), {
      headers: this.headers(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ready: false,
        status: `http_${response.status}`,
        details: { message: data.error || data.message || 'Data Fabric readiness request failed' },
      };
    }
    return {
      ready: data.ready !== false,
      status: data.ready === false ? 'not_ready' : 'ok',
      details: {
        service: data.service || data.name || 'data-fabric',
        version: data.version || '',
      },
    };
  }

  async sync({ tenantId, userId, options = {} }) {
    if (options.fixtures) return options.fixtures.map((item) => fabricFixtureToDocument({ tenantId, userId, item }));
    if (!this.isConfigured()) throw new Error('Data fabric connector is not configured');
    const url = new URL(urlFor(this.config.baseUrl, this.config.recordsPath));
    url.searchParams.set('tenantId', tenantId);
    url.searchParams.set('userId', userId);
    if (options.dataset) url.searchParams.set('dataset', options.dataset);
    if (options.since) url.searchParams.set('since', options.since);
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    const response = await fetch(url, { headers: this.headers() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || 'Data fabric records request failed');
    const records = data.records || data.items || data.data?.records || [];
    return records.map((item) => fabricFixtureToDocument({ tenantId, userId, item: normalizeRecord(item) }));
  }

  headers() {
    return {
      Accept: 'application/json',
      ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
    };
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

function normalizeRecord(item) {
  const record = item.record || item;
  const id = item.id || item.sourceId || item.key || record.id || record.key || stableRecordId(record);
  return {
    id,
    uri: item.uri || item.sourceUri || '',
    title: item.title || item.name || item.metric || item.dataset || `Data record ${id}`,
    summary: item.summary || item.description || '',
    text: item.text || item.body || '',
    record,
    owner: item.owner || item.author || 'data-fabric',
    timestamp: item.timestamp || item.updatedAt || item.createdAt || new Date().toISOString(),
    dataset: item.dataset || item.container || record.dataset || 'data-fabric',
    metadata: item.metadata || { record },
  };
}

function urlFor(baseUrl, suffixPath) {
  return new URL(suffixPath || '/', `${String(baseUrl || '').replace(/\/$/, '')}/`).toString();
}

function stableRecordId(record) {
  const value = JSON.stringify(record || {});
  let hash = 0;
  for (const char of value) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return `record_${Math.abs(hash)}`;
}
