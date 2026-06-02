import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = {
  schemaVersion: 1,
  tenants: {},      // tenantId -> { tenantId, name, createdAt }
  users: {},        // `${tenantId}:${userId}` -> { tenantId, userId, email, sources, createdAt }
  connections: {},  // `${tenantId}:${userId}` -> { [source]: { credentials, connectedAt } }
};

function scopeKey(tenantId, userId) {
  return `${tenantId}:${userId}`;
}

// Writable, JSON-backed registry of onboarded tenants, users, and the source
// credentials a user has connected. Mirrors JsonSearchStore's atomic-write +
// serialized-lock pattern. The connector token provider reads credentialsFor()
// so runtime-connected sources resolve without any static config.
export class OnboardingStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'onboarding.json');
    this.state = structuredClone(EMPTY_STATE);
    this.lock = Promise.resolve();
  }

  async withStoreLock(callback) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(await readFile(this.filePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
  }

  // ─── tenants (entity level) ─────────────────────────────────────────────────
  async createTenant({ tenantId, name = '' }) {
    if (!tenantId) throw new Error('tenantId is required');
    return this.withStoreLock(async () => {
      if (this.state.tenants[tenantId]) throw new Error(`Tenant already exists: ${tenantId}`);
      const tenant = { tenantId, name, createdAt: new Date().toISOString() };
      this.state.tenants[tenantId] = tenant;
      await this.save();
      return tenant;
    });
  }

  getTenant(tenantId) {
    return this.state.tenants[tenantId] || null;
  }

  // Idempotent get-or-create, used by self-serve OAuth where the workspace/user
  // may already exist from a prior login.
  async ensureTenant({ tenantId, name = '' }) {
    return this.getTenant(tenantId) || this.createTenant({ tenantId, name });
  }

  // ─── users (user level) ─────────────────────────────────────────────────────
  async createUser({ tenantId, userId, email = '', sources = [] }) {
    if (!tenantId || !userId) throw new Error('tenantId and userId are required');
    return this.withStoreLock(async () => {
      if (!this.state.tenants[tenantId]) throw new Error(`Unknown tenant: ${tenantId}`);
      const key = scopeKey(tenantId, userId);
      if (this.state.users[key]) throw new Error(`User already exists: ${tenantId}/${userId}`);
      const user = {
        tenantId,
        userId,
        email,
        sources: Array.isArray(sources) ? sources : [],
        createdAt: new Date().toISOString(),
      };
      this.state.users[key] = user;
      await this.save();
      return user;
    });
  }

  getUser(tenantId, userId) {
    return this.state.users[scopeKey(tenantId, userId)] || null;
  }

  async ensureUser({ tenantId, userId, email = '', sources = [] }) {
    return this.getUser(tenantId, userId) || this.createUser({ tenantId, userId, email, sources });
  }

  // ─── source connections (per {tenant}:{user}:{source}) ──────────────────────
  async connectSource({ tenantId, userId, source, credentials = {} }) {
    if (!tenantId || !userId || !source) throw new Error('tenantId, userId, and source are required');
    return this.withStoreLock(async () => {
      const key = scopeKey(tenantId, userId);
      if (!this.state.users[key]) throw new Error(`Unknown user: ${tenantId}/${userId}`);
      const existing = this.state.connections[key] || {};
      existing[source] = { credentials, connectedAt: new Date().toISOString() };
      this.state.connections[key] = existing;
      await this.save();
      return { source, connectedAt: existing[source].connectedAt };
    });
  }

  // Workspace-wide credential (e.g. a Slack bot token from one install) shared
  // by every user in the tenant. Stored under `${tenantId}:*`; credentialsFor
  // falls back to it for any user in the tenant.
  async connectTenantSource({ tenantId, source, credentials = {} }) {
    if (!tenantId || !source) throw new Error('tenantId and source are required');
    return this.withStoreLock(async () => {
      if (!this.state.tenants[tenantId]) throw new Error(`Unknown tenant: ${tenantId}`);
      const key = scopeKey(tenantId, '*');
      const existing = this.state.connections[key] || {};
      existing[source] = { credentials, connectedAt: new Date().toISOString() };
      this.state.connections[key] = existing;
      await this.save();
      return { source, connectedAt: existing[source].connectedAt };
    });
  }

  // Credential resolver consumed by ConnectorTokenProvider. Returns the raw
  // stored credentials for the most specific scope, or {} when not connected.
  credentialsFor(source, { tenantId = '', userId = '' } = {}) {
    const exact = this.state.connections[scopeKey(tenantId, userId)]?.[source]?.credentials;
    if (exact) return exact;
    const tenantWide = this.state.connections[scopeKey(tenantId, '*')]?.[source]?.credentials;
    return tenantWide || {};
  }

  listConnections(tenantId, userId) {
    const entry = this.state.connections[scopeKey(tenantId, userId)] || {};
    return Object.entries(entry).map(([source, value]) => ({ source, connectedAt: value.connectedAt }));
  }
}
