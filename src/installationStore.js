import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createCredentialCipher } from './credentialCipher.js';

export class InstallationStore {
  constructor(config) {
    this.config = config;
    const encryptionKey = config.connectorCredentialEncryptionKey
      || config.identity?.jwtSecret
      || config.auth?.token
      || (!config.postgres?.connectionString ? 'atlas-local-development-installations' : '');
    this.cipher = createCredentialCipher(encryptionKey);
    this.filePath = path.join(config.dataDir, 'installations.json');
    this.pool = config.postgres?.connectionString
      ? new pg.Pool({ connectionString: config.postgres.connectionString, ssl: config.postgres.ssl })
      : null;
    this.installations = new Map();
    this.events = new Map();
  }

  async load() {
    if (this.pool) {
      await this.refresh();
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const state = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.installations = new Map(Object.entries(state.installations || {}));
      this.events = new Map(Object.entries(state.events || {}));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveLocal();
    }
  }

  async refresh() {
    if (!this.pool) return this.load();
    const { rows } = await this.pool.query('SELECT * FROM connector_installations WHERE status = $1', ['connected']);
    this.installations = new Map(rows.map((row) => [installationKey(row.source, row.provider_team_id), fromRow(row)]));
  }

  async upsert({ source, providerTeamId, tenantId, userId, credentials, metadata = {} }) {
    const installation = {
      id: `${source}:${providerTeamId}`,
      source,
      providerTeamId,
      tenantId,
      userId,
      encryptedCredentials: this.cipher.encrypt(credentials),
      metadata,
      status: 'connected',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO connector_installations
          (id, source, provider_team_id, tenant_id, user_id, encrypted_credentials, metadata, status, connected_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'connected',now(),now())
         ON CONFLICT (source, provider_team_id) DO UPDATE SET
          tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id,
          encrypted_credentials=EXCLUDED.encrypted_credentials, metadata=EXCLUDED.metadata,
          status='connected', updated_at=now()`,
        [installation.id, source, providerTeamId, tenantId, userId, installation.encryptedCredentials, JSON.stringify(metadata)],
      );
    }
    this.installations.set(installationKey(source, providerTeamId), installation);
    if (!this.pool) await this.saveLocal();
    return publicInstallation(installation);
  }

  byProviderTeam(source, providerTeamId) {
    return publicInstallation(this.installations.get(installationKey(source, providerTeamId)));
  }

  credentialsFor(source, { tenantId = '', userId = '' } = {}) {
    const installation = [...this.installations.values()].find((item) => (
      item.source === source && item.tenantId === tenantId && (item.userId === userId || source === 'slack')
    ));
    return installation ? this.cipher.decrypt(installation.encryptedCredentials) : {};
  }

  async claimEvent({ eventId, source, providerTeamId, tenantId, userId }) {
    if (!eventId) return { claimed: true };
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO connector_events (event_id, source, provider_team_id, tenant_id, user_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, source, providerTeamId, tenantId, userId],
      );
      return { claimed: result.rowCount === 1 };
    }
    if (this.events.has(eventId)) return { claimed: false };
    this.events.set(eventId, { eventId, source, providerTeamId, tenantId, userId, status: 'received' });
    await this.saveLocal();
    return { claimed: true };
  }

  async markEventJob(eventId, jobId) {
    if (!eventId) return;
    if (this.pool) {
      await this.pool.query('UPDATE connector_events SET job_id=$2, status=$3, updated_at=now() WHERE event_id=$1', [eventId, jobId, 'queued']);
      return;
    }
    const event = this.events.get(eventId);
    if (event) {
      this.events.set(eventId, { ...event, jobId, status: 'queued' });
      await this.saveLocal();
    }
  }

  async markEventOutcome(jobId, status) {
    if (!jobId || !['completed', 'failed'].includes(status)) return;
    if (this.pool) {
      await this.pool.query(
        'UPDATE connector_events SET status=$2, updated_at=now() WHERE job_id=$1',
        [jobId, status],
      );
      return;
    }
    for (const [eventId, event] of this.events) {
      if (event.jobId !== jobId) continue;
      this.events.set(eventId, { ...event, status });
    }
    await this.saveLocal();
  }

  eventById(eventId) {
    return this.events.get(eventId) || null;
  }

  async releaseEvent(eventId) {
    if (!eventId) return;
    if (this.pool) {
      await this.pool.query('DELETE FROM connector_events WHERE event_id=$1 AND status=$2', [eventId, 'received']);
      return;
    }
    this.events.delete(eventId);
    await this.saveLocal();
  }

  async close() {
    await this.pool?.end();
  }

  async saveLocal() {
    const state = {
      installations: Object.fromEntries(this.installations),
      events: Object.fromEntries(this.events),
    };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.filePath);
  }
}

function installationKey(source, providerTeamId) {
  return `${source}:${providerTeamId}`;
}

function fromRow(row) {
  return {
    id: row.id,
    source: row.source,
    providerTeamId: row.provider_team_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    encryptedCredentials: row.encrypted_credentials,
    metadata: row.metadata || {},
    status: row.status,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

function publicInstallation(value) {
  if (!value) return null;
  const { encryptedCredentials: _encryptedCredentials, ...installation } = value;
  return installation;
}
