// Start api + worker-core + worker-browser + worker-media + web (http://localhost:3000) with one command.
// Usage: pnpm dev:all   (expects Postgres from `pnpm db:local` and a migrated + seeded DB)
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';

async function checkDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('Thiếu DATABASE_URL trong .env.');
  const address = new URL(databaseUrl);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new pg.Client({ connectionString: address.href, connectionTimeoutMillis: 2500, query_timeout: 2500 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === 3) {
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
        const authFailed = typeof error.code === 'string' && error.code.startsWith('28');
        const hint = local && !authFailed
          ? 'Chạy pnpm db:local trong terminal riêng (khởi động lại nếu đang treo), rồi chạy lại pnpm dev:all.'
          : 'Kiểm tra dịch vụ PostgreSQL và DATABASE_URL, rồi chạy lại pnpm dev:all.';
        const code = typeof error.code === 'string' ? ' (' + error.code + ')' : '';
        throw new Error('PostgreSQL tại ' + address.hostname + ':' + (address.port || '5432') + ' không trả lời truy vấn kiểm tra' + code + '. ' + hint);
      }
    } finally {
      await client.end();
    }
    await delay(500);
  }
}

let env;
try {
  env = { ...parseEnv(await readFile('.env', 'utf8')), ...process.env };
  await checkDatabase(env.DATABASE_URL);
} catch (error) {
  console.error('[dev:all]', error.code === 'ENOENT' ? 'Thiếu .env. Sao chép .env.example thành .env và điền cấu hình.' : error.message);
  process.exit(1);
}

const apps = ['api', 'worker-core', 'worker-browser', 'worker-media', 'web'];
const children = apps.map((app) => {
  const child =
    app === 'web'
      ? spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '3000'], {
          cwd: 'apps/web',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, API_URL: env.API_URL ?? ('http://127.0.0.1:' + (env.API_PORT ?? '3001')), NEXT_TELEMETRY_DISABLED: '1' },
        })
      : spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', `apps/${app}/src/main.ts`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
  const tag = `[${app}]`.padEnd(17);
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => console.log(tag, l)));
  }
  child.on('exit', (code) => console.log(tag, `exited with ${code}`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
