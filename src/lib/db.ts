import 'server-only';
import { Pool as NeonPool, PoolClient, neonConfig } from '@neondatabase/serverless';
import { Pool as NodePostgresPool } from 'pg';
import ws from 'ws';
import { getConfig } from './config';

neonConfig.webSocketConstructor = ws;

function createDbPool(): NeonPool {
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not defined in environment.');
  }
  const databaseUrl = new URL(config.databaseUrl);
  // The Neon driver speaks WebSocket and cannot connect directly to local
  // PostgreSQL. Keep the deployed driver while enabling isolated local tests.
  const PoolImplementation = ['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)
    ? NodePostgresPool
    : NeonPool;
  return new PoolImplementation({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  }) as unknown as NeonPool;
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options?: { lockTimeoutMs?: number; statementTimeoutMs?: number }
): Promise<T> {
  const pool = createDbPool();
  let client: PoolClient;

  try {
    client = await pool.connect();
  } catch (error) {
    try { await pool.end(); } catch {}
    throw error;
  }

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
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}

export async function withAdvisoryLock<T>(
  lockId: number,
  callback: () => Promise<T>
): Promise<T> {
  const pool = createDbPool();
  let client: PoolClient;
  let acquired = false;

  try {
    client = await pool.connect();
  } catch (error) {
    try { await pool.end(); } catch {}
    throw error;
  }

  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    acquired = true;
    return await callback();
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
      } catch {
        // Release the connection even when the unlock query fails.
      }
    }
    client.release();
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}

export async function queryDb<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  options?: { statementTimeoutMs?: number }
): Promise<T[]> {
  const pool = createDbPool();
  let client: PoolClient;

  try {
    client = await pool.connect();
  } catch (error) {
    try { await pool.end(); } catch {}
    throw error;
  }

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
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}
