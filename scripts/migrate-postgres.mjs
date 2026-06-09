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
const migrations = [
  '001_pgvector_store.sql',
  '002_connector_installations.sql',
];
const pool = new pg.Pool({ connectionString: config.postgres.connectionString, ssl: config.postgres.ssl });

try {
  for (const file of migrations) {
    const migration = await readFile(path.join(root, 'migrations', file), 'utf8');
    await pool.query(migration);
    console.log(`Postgres migration completed: ${file}`);
  }
} finally {
  await pool.end();
}
