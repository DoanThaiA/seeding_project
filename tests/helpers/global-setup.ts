import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

const PORT = Number(process.env.TEST_PG_PORT ?? 54339);
export const TEMPLATE = 'seedingsys_template';

/**
 * One throw-away Postgres for the whole run. Migrations are applied once to a template database;
 * every test file clones it (CREATE DATABASE ... TEMPLATE), so tests are isolated and fast.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const dir = mkdtempSync(join(tmpdir(), 'seedingsys-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'test',
    password: 'test',
    port: PORT,
    persistent: true, // we remove the directory ourselves (Windows keeps file locks briefly after stop)
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  const adminUrl = `postgresql://test:test@127.0.0.1:${PORT}`;
  const admin = new Client({ connectionString: `${adminUrl}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  await admin.end();

  const c = new Client({ connectionString: `${adminUrl}/${TEMPLATE}` });
  await c.connect();
  const migDir = join(__dirname, '..', '..', 'packages', 'db', 'prisma', 'migrations');
  for (const m of readdirSync(migDir).filter((d) => !d.endsWith('.toml')).sort()) {
    await c.query(readFileSync(join(migDir, m, 'migration.sql'), 'utf8'));
  }
  await c.end();

  provide('pgAdminUrl', adminUrl);
  provide('pgTemplate', TEMPLATE);
  return async () => {
    try {
      await pg.stop();
    } catch {
      /* already stopped */
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* leftover temp dir is harmless */
    }
  };
}
