import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.postgres.connectionString) {
  console.error('POSTGRES_CONNECTION_STRING is required');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await readFile(path.join(root, 'migrations/001_pgvector_store.sql'), 'utf8');
const pool = new pg.Pool({ connectionString: config.postgres.connectionString, ssl: config.postgres.ssl });

try {
  await pool.query(migration);
  console.log('Postgres migration completed');
} finally {
  await pool.end();
}
