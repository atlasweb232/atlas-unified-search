import pg from 'pg';
import { JsonSearchStore, redactObject } from '../store.js';

export class PostgresSearchStore extends JsonSearchStore {
  constructor({ connectionString, ssl = true, embeddingDim = 768 }) {
    super({ dataDir: '/tmp/atlas-unified-search-postgres-cache' });
    this.name = 'postgres-pgvector';
    this.pool = new pg.Pool({ connectionString, ssl });
    this.embeddingDim = Number(embeddingDim) || 768;
    this.pendingDeletedDocumentIds = new Set();
    this.pendingDeletedCheckpointKeys = new Set();
  }

  async load() {
    await this.pool.query('SELECT 1');
    await this.assertVectorColumnDim();
    await this.loadStateFromPostgres();
  }

  // Fail fast if the vector column width != configured EMBEDDING_DIM. pgvector
  // stores the declared dimension directly in atttypmod. A mismatch here is the
  // original silent-NULL bug surfacing as a hard startup error instead.
  async assertVectorColumnDim() {
    const { rows } = await this.pool.query(
      `SELECT atttypmod AS dim FROM pg_attribute
       WHERE attrelid = 'unified_chunks'::regclass AND attname = 'embedding'`,
    );
    const columnDim = rows[0]?.dim;
    if (Number.isFinite(columnDim) && columnDim > 0 && columnDim !== this.embeddingDim) {
      throw new Error(
        `Vector column unified_chunks.embedding is vector(${columnDim}) but EMBEDDING_DIM=${this.embeddingDim}. `
        + 'Run the migration that parameterizes the column to the configured width.',
      );
    }
  }

  async refresh() {
    await this.loadStateFromPostgres();
  }

  async save() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (this.pendingDeletedDocumentIds.size) {
        const ids = [...this.pendingDeletedDocumentIds];
        await client.query('DELETE FROM unified_chunks WHERE document_id = ANY($1::text[])', [ids]);
        await client.query('DELETE FROM unified_documents WHERE id = ANY($1::text[])', [ids]);
      }
      if (this.pendingDeletedCheckpointKeys.size) {
        await client.query('DELETE FROM unified_checkpoints WHERE key = ANY($1::text[])', [[...this.pendingDeletedCheckpointKeys]]);
      }
      for (const document of Object.values(this.state.documents)) {
        await upsertDocument(client, document);
      }
      for (const chunk of Object.values(this.state.chunks)) {
        await upsertChunk(client, chunk, this.embeddingDim);
      }
      for (const [key, checkpoint] of Object.entries(this.state.checkpoints)) {
        await client.query(
          `INSERT INTO unified_checkpoints (key, checkpoint, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = now()`,
          [key, checkpoint],
        );
      }
      for (const job of Object.values(this.state.jobs)) {
        await upsertJob(client, job);
      }
      for (const run of Object.values(this.state.searchRuns)) {
        await upsertSearchRun(client, run);
      }
      for (const action of Object.values(this.state.assistantActions)) {
        await upsertAssistantAction(client, action);
      }
      for (const artifact of Object.values(this.state.artifacts)) {
        await upsertArtifact(client, artifact);
      }
      for (const event of this.state.audit.slice(0, 1000)) {
        await client.query(
          `INSERT INTO unified_audit (id, tenant_id, user_id, event_type, event, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [event.id, event.tenantId || '', event.userId || '', event.eventType || 'unknown', redactObject(event), event.createdAt || new Date().toISOString()],
        );
      }
      await client.query('COMMIT');
      this.pendingDeletedDocumentIds.clear();
      this.pendingDeletedCheckpointKeys.clear();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  deleteDocuments(args) {
    const deleted = super.deleteDocuments(args);
    for (const id of deleted.documentIds) this.pendingDeletedDocumentIds.add(id);
    return deleted;
  }

  deleteCheckpoints({ tenantId, userId, source = '' }) {
    const prefix = source ? `${source}:${tenantId}:${userId}:` : '';
    const keys = Object.keys(this.state.checkpoints).filter((key) => (
      prefix ? key.startsWith(prefix) : key.includes(`:${tenantId}:${userId}:`)
    ));
    const deleted = super.deleteCheckpoints({ tenantId, userId, source });
    for (const key of keys) this.pendingDeletedCheckpointKeys.add(key);
    return deleted;
  }

  status() {
    return { ...super.status(), backend: this.name };
  }

  scopedStatus(scope) {
    return { ...super.scopedStatus(scope), backend: this.name };
  }

  async cleanupRetention({ tenantId, userId, documentRetentionDays, operationalRetentionDays, auditRetentionDays, dryRun = false }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const params = [tenantId, userId];
      const documentCutoff = `${positiveDays(documentRetentionDays, 90)} days`;
      const operationalCutoff = `${positiveDays(operationalRetentionDays, 30)} days`;
      const auditCutoff = `${positiveDays(auditRetentionDays, 90)} days`;
      const scoped = 'tenant_id = $1 AND user_id = $2';
      const documentIds = await client.query(
        `SELECT id FROM unified_documents WHERE ${scoped} AND COALESCE(updated_at, timestamp, created_at) < now() - $3::interval`,
        [...params, documentCutoff],
      );
      const artifactIds = await client.query(
        `SELECT id FROM unified_artifacts WHERE ${scoped} AND created_at < now() - $3::interval`,
        [...params, operationalCutoff],
      );
      const counts = {
        documents: documentIds.rowCount,
        chunks: Number((await client.query(
          `SELECT count(*)::int AS count FROM unified_chunks WHERE ${scoped} AND document_id = ANY($3::text[])`,
          [...params, documentIds.rows.map((row) => row.id)],
        )).rows[0]?.count || 0),
        checkpoints: Number((await client.query(
          `SELECT count(*)::int AS count FROM unified_checkpoints WHERE key LIKE $1 AND COALESCE((checkpoint->>'updatedAt')::timestamptz, (checkpoint->>'lastSyncedAt')::timestamptz, updated_at) < now() - $2::interval`,
          [`%:${tenantId}:${userId}:%`, operationalCutoff],
        )).rows[0]?.count || 0),
        jobs: Number((await client.query(`SELECT count(*)::int AS count FROM unified_jobs WHERE ${scoped} AND updated_at < now() - $3::interval`, [...params, operationalCutoff])).rows[0]?.count || 0),
        searchRuns: Number((await client.query(`SELECT count(*)::int AS count FROM unified_search_runs WHERE ${scoped} AND updated_at < now() - $3::interval`, [...params, operationalCutoff])).rows[0]?.count || 0),
        assistantActions: Number((await client.query(`SELECT count(*)::int AS count FROM unified_assistant_actions WHERE ${scoped} AND COALESCE(completed_at, created_at) < now() - $3::interval`, [...params, operationalCutoff])).rows[0]?.count || 0),
        artifacts: artifactIds.rowCount,
        audit: Number((await client.query(`SELECT count(*)::int AS count FROM unified_audit WHERE ${scoped} AND created_at < now() - $3::interval`, [...params, auditCutoff])).rows[0]?.count || 0),
      };
      const report = {
        tenantId,
        userId,
        dryRun: Boolean(dryRun),
        cutoffs: {
          documentsBefore: documentCutoff,
          operationalBefore: operationalCutoff,
          auditBefore: auditCutoff,
        },
        deleted: counts,
        documentIds: documentIds.rows.map((row) => row.id),
        artifactIds: artifactIds.rows.map((row) => row.id),
      };
      if (!dryRun) {
        await client.query(`DELETE FROM unified_chunks WHERE ${scoped} AND document_id = ANY($3::text[])`, [...params, report.documentIds]);
        await client.query(`DELETE FROM unified_documents WHERE id = ANY($1::text[])`, [report.documentIds]);
        await client.query(
          `DELETE FROM unified_checkpoints WHERE key LIKE $1 AND COALESCE((checkpoint->>'updatedAt')::timestamptz, (checkpoint->>'lastSyncedAt')::timestamptz, updated_at) < now() - $2::interval`,
          [`%:${tenantId}:${userId}:%`, operationalCutoff],
        );
        await client.query(`DELETE FROM unified_jobs WHERE ${scoped} AND updated_at < now() - $3::interval`, [...params, operationalCutoff]);
        await client.query(`DELETE FROM unified_search_runs WHERE ${scoped} AND updated_at < now() - $3::interval`, [...params, operationalCutoff]);
        await client.query(`DELETE FROM unified_assistant_actions WHERE ${scoped} AND COALESCE(completed_at, created_at) < now() - $3::interval`, [...params, operationalCutoff]);
        await client.query(`DELETE FROM unified_artifacts WHERE id = ANY($1::text[])`, [report.artifactIds]);
        await client.query(`DELETE FROM unified_audit WHERE ${scoped} AND created_at < now() - $3::interval`, [...params, auditCutoff]);
      }
      await client.query('COMMIT');
      if (!dryRun) await this.loadStateFromPostgres();
      return report;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async loadStateFromPostgres() {
    const [documents, chunks, checkpoints, jobs, runs, actions, artifacts, audit] = await Promise.all([
      this.pool.query('SELECT * FROM unified_documents'),
      this.pool.query('SELECT * FROM unified_chunks'),
      this.pool.query('SELECT * FROM unified_checkpoints'),
      this.pool.query('SELECT * FROM unified_jobs'),
      this.pool.query('SELECT * FROM unified_search_runs'),
      this.pool.query('SELECT * FROM unified_assistant_actions'),
      this.pool.query('SELECT * FROM unified_artifacts'),
      this.pool.query('SELECT * FROM unified_audit ORDER BY created_at DESC LIMIT 1000'),
    ]);

    this.state.documents = Object.fromEntries(documents.rows.map((row) => [row.id, documentFromRow(row)]));
    this.state.chunks = Object.fromEntries(chunks.rows.map((row) => [row.id, chunkFromRow(row)]));
    this.state.checkpoints = Object.fromEntries(checkpoints.rows.map((row) => [row.key, row.checkpoint]));
    this.state.jobs = Object.fromEntries(jobs.rows.map((row) => [row.id, jobFromRow(row)]));
    this.state.searchRuns = Object.fromEntries(runs.rows.map((row) => [row.id, searchRunFromRow(row)]));
    this.state.assistantActions = Object.fromEntries(actions.rows.map((row) => [row.id, assistantActionFromRow(row)]));
    this.state.artifacts = Object.fromEntries(artifacts.rows.map((row) => [row.id, artifactFromRow(row)]));
    this.state.audit = audit.rows.map((row) => ({ id: row.id, createdAt: iso(row.created_at), ...row.event }));
  }
}

export async function createSearchStore(config) {
  if (config.postgres?.connectionString) {
    return new PostgresSearchStore({ ...config.postgres, embeddingDim: config.embeddingDim });
  }
  return new JsonSearchStore({ dataDir: config.dataDir });
}

async function upsertDocument(client, document) {
  await client.query(
    `INSERT INTO unified_documents
      (id, tenant_id, user_id, source, source_id, title, summary, author, container, timestamp, source_uri, body, children, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
     ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title, summary=EXCLUDED.summary, author=EXCLUDED.author, container=EXCLUDED.container,
      timestamp=EXCLUDED.timestamp, source_uri=EXCLUDED.source_uri, body=EXCLUDED.body,
      children=EXCLUDED.children, metadata=EXCLUDED.metadata, updated_at=now()`,
    [
      document.id, document.tenantId, document.userId, document.source, document.sourceId || '',
      document.title || '', document.summary || '', document.author || '', document.container || '',
      nullableIso(document.timestamp), document.sourceUri || '', document.body || '',
      JSON.stringify(document.children || []), JSON.stringify(document.metadata || {}),
    ],
  );
}

async function upsertChunk(client, chunk, embeddingDim = 768) {
  const vector = Array.isArray(chunk.embedding) && chunk.embedding.length === embeddingDim ? `[${chunk.embedding.join(',')}]` : null;
  await client.query(
    `INSERT INTO unified_chunks
      (id, document_id, tenant_id, user_id, source, text, summary, embedding_model, embedding_version, embedding, embedding_json, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,$12,now())
     ON CONFLICT (id) DO UPDATE SET
      text=EXCLUDED.text, summary=EXCLUDED.summary, embedding_model=EXCLUDED.embedding_model,
      embedding_version=EXCLUDED.embedding_version, embedding=EXCLUDED.embedding,
      embedding_json=EXCLUDED.embedding_json, metadata=EXCLUDED.metadata, updated_at=now()`,
    [
      chunk.id, chunk.documentId, chunk.tenantId, chunk.userId, chunk.source,
      chunk.text || '', chunk.summary || '', chunk.embeddingModel || '', chunk.embeddingVersion || '',
      vector, JSON.stringify(chunk.embedding || []), JSON.stringify(chunk.metadata || {}),
    ],
  );
}

async function upsertJob(client, job) {
  await client.query(
    `INSERT INTO unified_jobs (id, source, tenant_id, user_id, status, indexed, error, payload, created_at, updated_at, started_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, indexed=EXCLUDED.indexed, error=EXCLUDED.error,
      payload=EXCLUDED.payload, updated_at=now(), started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at`,
    [job.id, job.source, job.tenantId, job.userId, job.status, job.indexed || 0, job.error || '', JSON.stringify(job), nullableIso(job.createdAt) || new Date().toISOString(), nullableIso(job.startedAt), nullableIso(job.completedAt)],
  );
}

async function upsertSearchRun(client, run) {
  await client.query(
    `INSERT INTO unified_search_runs (id, tenant_id, user_id, query, selected_sources, filters, status, source_statuses, results, created_at, updated_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, source_statuses=EXCLUDED.source_statuses,
      results=EXCLUDED.results, updated_at=now(), completed_at=EXCLUDED.completed_at`,
    [run.id, run.tenantId, run.userId, run.query, JSON.stringify(run.selectedSources || []), JSON.stringify(run.filters || {}), run.status, JSON.stringify(run.sourceStatuses || []), JSON.stringify(run.results || []), nullableIso(run.createdAt), nullableIso(run.completedAt)],
  );
}

async function upsertAssistantAction(client, action) {
  await client.query(
    `INSERT INTO unified_assistant_actions
      (id, tenant_id, user_id, search_run_id, action_type, selected_result_ids, prompt, provider, status, response_text, artifact_ids, error, created_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, response_text=EXCLUDED.response_text,
      artifact_ids=EXCLUDED.artifact_ids, error=EXCLUDED.error, completed_at=EXCLUDED.completed_at`,
    [action.id, action.tenantId, action.userId, action.searchRunId, action.actionType, JSON.stringify(action.selectedResultIds || []), action.prompt || '', action.provider || '', action.status, action.responseText || '', JSON.stringify(action.artifactIds || []), action.error || '', nullableIso(action.createdAt), nullableIso(action.completedAt)],
  );
}

async function upsertArtifact(client, artifact) {
  await client.query(
    `INSERT INTO unified_artifacts (id, tenant_id, user_id, type, title, storage_uri, download_url, mime_type, size_bytes, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET storage_uri=EXCLUDED.storage_uri, download_url=EXCLUDED.download_url, metadata=EXCLUDED.metadata`,
    [artifact.id, artifact.tenantId || '', artifact.userId || '', artifact.type || '', artifact.title || '', artifact.storageUri || '', artifact.downloadUrl || '', artifact.mimeType || '', artifact.size || artifact.sizeBytes || 0, JSON.stringify(artifact.metadata || {}), nullableIso(artifact.createdAt)],
  );
}

function documentFromRow(row) {
  return {
    id: row.id, tenantId: row.tenant_id, userId: row.user_id, source: row.source, sourceId: row.source_id,
    title: row.title, summary: row.summary, author: row.author, container: row.container,
    timestamp: iso(row.timestamp), sourceUri: row.source_uri, body: row.body,
    children: row.children || [], metadata: row.metadata || {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function chunkFromRow(row) {
  return {
    id: row.id, documentId: row.document_id, tenantId: row.tenant_id, userId: row.user_id, source: row.source,
    text: row.text, summary: row.summary, embeddingModel: row.embedding_model, embeddingVersion: row.embedding_version,
    embedding: row.embedding_json || [], metadata: row.metadata || {},
  };
}

function jobFromRow(row) {
  return { ...(row.payload || {}), id: row.id, source: row.source, tenantId: row.tenant_id, userId: row.user_id, status: row.status, indexed: row.indexed, error: row.error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at) };
}

function searchRunFromRow(row) {
  return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, query: row.query, selectedSources: row.selected_sources || [], filters: row.filters || {}, status: row.status, sourceStatuses: row.source_statuses || [], results: row.results || [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), completedAt: iso(row.completed_at) };
}

function assistantActionFromRow(row) {
  return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, searchRunId: row.search_run_id, actionType: row.action_type, selectedResultIds: row.selected_result_ids || [], prompt: row.prompt, provider: row.provider, status: row.status, responseText: row.response_text, artifactIds: row.artifact_ids || [], error: row.error, createdAt: iso(row.created_at), completedAt: iso(row.completed_at) };
}

function artifactFromRow(row) {
  return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, type: row.type, title: row.title, storageUri: row.storage_uri, downloadUrl: row.download_url, mimeType: row.mime_type, size: row.size_bytes, metadata: row.metadata || {}, createdAt: iso(row.created_at) };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function positiveDays(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
