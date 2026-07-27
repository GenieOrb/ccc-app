import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const match = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  if (!match) return;
  const raw = match[1].trim();
  process.env.DATABASE_URL = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1)
    : raw;
}

async function setupDatabase() {
  loadLocalDatabaseUrl();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is missing.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, 'setup-db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Connecting to Neon PostgreSQL...');
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log('Executing database schema script...');
    await client.query(sql);
    console.log('Database setup completed successfully!');
  } catch (error) {
    console.error('Failed to setup database:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();
