import 'server-only';
import { Pool, PoolClient, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { getConfig } from './config';

neonConfig.webSocketConstructor = ws;

let globalPool: Pool | null = null;

export function getDbPool(): Pool {
  if (!globalPool) {
    const config = getConfig();
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not defined in environment.');
    }
    globalPool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return globalPool;
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options?: { lockTimeoutMs?: number; statementTimeoutMs?: number }
): Promise<T> {
  const pool = getDbPool();
  const client = await pool.connect();
  const lockTimeout = options?.lockTimeoutMs ?? 3000;
  const statementTimeout = options?.statementTimeoutMs ?? 10000;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function queryDb<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  options?: { statementTimeoutMs?: number }
): Promise<T[]> {
  const pool = getDbPool();
  const client = await pool.connect();
  const statementTimeout = options?.statementTimeoutMs ?? 10000;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
}
