import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

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
    
    // Verificar que las tablas críticas existen
    const tables = ['campaigns', 'meme_drafts', 'meme_assets', 'meme_generation_cycles', 'meme_generation_jobs', 'memes', 'meme_api_calls', 'assignments'];
    for (const table of tables) {
      const res = await client.query('SELECT to_regclass($1)', [table]);
      if (!res.rows[0].to_regclass) {
        throw new Error(`Critical table missing: ${table}`);
      }
    }
    
    // Verificar columnas en campaigns
    const cols = ['include_memes', 'meme_percentage', 'meme_model_key'];
    for (const col of cols) {
      const res = await client.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', ['campaigns', col]);
      if (res.rowCount === 0) {
        throw new Error(`Critical column missing: campaigns.${col}`);
      }
    }
    
    // Verificar columnas en assignments
    const resAssignments = await client.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name IN ($2, $3)', ['assignments', 'content_type', 'meme_id']);
    if (resAssignments.rowCount !== 2) {
      throw new Error('Critical columns missing in assignments');
    }

    console.log('Database setup and schema verification completed successfully!');
  } catch (error) {
    console.error('Failed to setup database:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();
