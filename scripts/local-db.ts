/**
 * Local PostgreSQL for development without Docker (uses the embedded-postgres binaries).
 *   pnpm db:local            → starts Postgres on 127.0.0.1:54329, data in .data/pg
 * Then in another terminal: pnpm db:migrate && pnpm db:seed
 * DATABASE_URL=postgresql://seedingsys:seedingsys@127.0.0.1:54329/seedingsys
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.LOCAL_PG_PORT ?? 54329);
const DIR = join(__dirname, '..', '.data', 'pg');

async function main() {
  if (existsSync(join(__dirname, '..', '.data', 'MOVED.json'))) {
    throw new Error('Hệ thống đã chuyển sang máy khác (.data/MOVED.json). Hủy chuyển: node scripts/move-machine.mjs reactivate');
  }
  const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    user: 'seedingsys',
    password: 'seedingsys',
    port: PORT,
    persistent: true,
    // Vietnamese captions require UTF-8 regardless of the Windows code page.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (line) => console.log('[postgres]', line.trimEnd()),
  });
  const fresh = !existsSync(join(DIR, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('seedingsys');
  console.log(`Postgres ready: postgresql://seedingsys:seedingsys@127.0.0.1:${PORT}/seedingsys (Ctrl+C to stop)`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
