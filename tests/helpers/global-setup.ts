import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

export const TEMPLATE = 'seedingsys_template';

async function testPort() {
  const configured = process.env.TEST_PG_PORT;
  if (configured !== undefined) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TEST_PG_PORT must be a valid TCP port.');
    return port;
  }
  return new Promise<number>((resolve, reject) => {
    const listener = createServer().once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(error => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('Could not select a test database port.'));
        else resolve(address.port);
      });
    });
  });
}

/**
 * One throw-away Postgres for the whole run. Migrations are applied once to a template database;
 * every test file clones it (CREATE DATABASE ... TEMPLATE), so tests are isolated and fast.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const port = await testPort();
  const dir = mkdtempSync(join(tmpdir(), 'seedingsys-pg-'));
  let lastLog = '';
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'test',
    password: 'test',
    port,
    persistent: true, // we remove the directory ourselves (Windows keeps file locks briefly after stop)
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: line => { lastLog = (lastLog + line).slice(-2000); },
  });
  const removeTempDir = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* leftover temp dir is harmless */
    }
  };
  try {
    await pg.initialise();
    await pg.start();
  } catch (error) {
    removeTempDir();
    throw new Error(`Could not start test PostgreSQL on port ${port}.\n${lastLog}`, { cause: error });
  }
  const cleanup = async () => {
    try {
      await pg.stop();
    } finally {
      removeTempDir();
    }
  };
  const adminUrl = `postgresql://test:test@127.0.0.1:${port}`;
  const admin = new Client({ connectionString: `${adminUrl}/postgres` });
  const c = new Client({ connectionString: `${adminUrl}/${TEMPLATE}` });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TEMPLATE}`);
    await c.connect();
    const migDir = join(__dirname, '..', '..', 'packages', 'db', 'prisma', 'migrations');
    for (const migration of readdirSync(migDir).filter((entry) => !entry.endsWith('.toml')).sort()) {
      await c.query(readFileSync(join(migDir, migration, 'migration.sql'), 'utf8'));
    }
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    await Promise.all([admin.end(), c.end()]);
  }
  await c.end();

  provide('pgAdminUrl', adminUrl);
  provide('pgTemplate', TEMPLATE);
  return cleanup;
}
