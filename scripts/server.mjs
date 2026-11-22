// Run SeedingSys permanently on this machine without Docker: Postgres + api + 3 workers + web,
// each restarted automatically if it crashes, with daily log files and a DB snapshot on every start.
//
//   node scripts/server.mjs start    supervise in the foreground (the "SeedingSys" scheduled task runs this hidden at logon)
//   node scripts/server.mjs stop     ask the running supervisor to shut everything down cleanly
//   node scripts/server.mjs status   is it running, are web/api answering, where are the logs
//
// Needs a production web build first: pnpm build:web   (again after every code update)
// Optional settings (in .env or the environment):
//   WEB_PORT=3000  API_HOST=127.0.0.1 (API stays off the LAN)  WEB_INSECURE_COOKIE=1 (plain-HTTP login works on the LAN)
//   SERVER_APPS=api,worker-core,worker-browser,worker-media,web   LOG_KEEP_DAYS=14
//   SNAPSHOT_DIR=.data/pg-snapshots  SNAPSHOT_KEEP=7   (point SNAPSHOT_DIR at another drive or a synced folder)
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const RUN_DIR = join(ROOT, '.data', 'run');
const PID_FILE = join(RUN_DIR, 'supervisor.pid');
const STOP_FILE = join(RUN_DIR, 'stop');
const LOG_DIR = join(ROOT, '.data', 'logs');
const PG_DIR = join(ROOT, '.data', 'pg');
const ALL_APPS = ['api', 'worker-core', 'worker-browser', 'worker-media', 'web'];

function loadEnv() {
  if (!existsSync('.env')) throw new Error('Thiếu .env. Sao chép .env.example thành .env và điền cấu hình.');
  return { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function runningSupervisor() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const info = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    return isAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // operations run on Asia/Ho_Chi_Minh
const stamp = () => new Date().toISOString();

// One file per app per day: .data/logs/<app>-YYYY-MM-DD.log
const streams = new Map();
function logLine(app, line) {
  const file = join(LOG_DIR, `${app}-${today()}.log`);
  let s = streams.get(app);
  if (!s || s.path !== file) {
    s?.end();
    s = createWriteStream(file, { flags: 'a' });
    streams.set(app, s);
  }
  s.write(`${stamp()} ${line}\n`);
  if (process.stdout.isTTY) console.log(`[${app}]`.padEnd(17), line);
}
const log = (line) => logLine('supervisor', line);

function pruneLogs(keepDays) {
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const f of readdirSync(LOG_DIR)) {
    const p = join(LOG_DIR, f);
    if (f.endsWith('.log') && statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
  }
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(1500);
    sock.once('connect', () => (sock.destroy(), done(true)));
    sock.once('timeout', () => (sock.destroy(), done(false)));
    sock.once('error', () => done(false));
  });
}

// Cold copy of the data directory while Postgres is stopped, so the copy is always consistent.
async function snapshotDb(dir, keep) {
  if (!existsSync(join(PG_DIR, 'PG_VERSION'))) return;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `pg-${stamp().replace(/[:.]/g, '-')}`);
  await cp(PG_DIR, target, { recursive: true, filter: (src) => !/postmaster\.(pid|opts)$/.test(src) });
  log(`Đã sao lưu DB: ${target}`);
  const old = readdirSync(dir).filter((f) => f.startsWith('pg-')).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { recursive: true, force: true });
}

async function startPostgres(env) {
  const url = new URL(env.DATABASE_URL);
  const port = Number(url.port || 5432);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (await portOpen(port)) {
    log(`Postgres đã chạy sẵn ở cổng ${port}, dùng luôn (không tự tắt khi dừng).`);
    return null;
  }
  if (!local || port !== Number(env.LOCAL_PG_PORT ?? 54329)) {
    throw new Error(`Không kết nối được Postgres ở ${url.hostname}:${port}. Kiểm tra DATABASE_URL.`);
  }
  try {
    await snapshotDb(resolve(env.SNAPSHOT_DIR ?? '.data/pg-snapshots'), Number(env.SNAPSHOT_KEEP ?? 7));
  } catch (e) {
    log(`CẢNH BÁO: sao lưu DB thất bại: ${e.message}`);
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const fresh = !existsSync(join(PG_DIR, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: url.username || 'seedingsys',
    password: decodeURIComponent(url.password || 'seedingsys'),
    port,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (line) => logLine('postgres', String(line).trimEnd()),
    onError: (line) => logLine('postgres', String(line).trimEnd()),
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(url.pathname.slice(1) || 'seedingsys');
  log(`Postgres sẵn sàng ở cổng ${port}.`);
  return pg;
}

function migrate(env) {
  log('Chạy migration...');
  const r = spawnSync(
    process.execPath,
    ['packages/db/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'],
    { env: { ...process.env, DATABASE_URL: env.DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, encoding: 'utf8' },
  );
  for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(Boolean)) logLine('migrate', l);
  if (r.status !== 0) throw new Error('Migration thất bại, xem .data/logs/migrate-*.log');
}

function appCommand(app, env) {
  const apiPort = env.API_PORT ?? '3001';
  const base = { ...process.env, NODE_ENV: 'production', API_HOST: env.API_HOST ?? '127.0.0.1' };
  if (app === 'web') {
    return {
      args: ['node_modules/next/dist/bin/next', 'start', '--port', String(env.WEB_PORT ?? '3000')],
      cwd: join(ROOT, 'apps', 'web'),
      env: {
        ...base,
        API_URL: env.API_URL ?? `http://127.0.0.1:${apiPort}`,
        NEXT_TELEMETRY_DISABLED: '1',
        WEB_INSECURE_COOKIE: env.WEB_INSECURE_COOKIE ?? '1',
      },
    };
  }
  return { args: ['--env-file=.env', '--import', 'tsx', `apps/${app}/src/main.ts`], cwd: ROOT, env: base };
}

// Windows has no SIGTERM for other processes: end the whole tree so nothing keeps holding a port.
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function start() {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const other = runningSupervisor();
  if (other) {
    console.error(`SeedingSys đang chạy rồi (PID ${other.pid}, từ ${other.startedAt}).`);
    process.exit(0);
  }
  rmSync(STOP_FILE, { force: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, startedAt: stamp() }));
  process.on('exit', () => {
    if (runningSupervisor()?.pid === process.pid) rmSync(PID_FILE, { force: true });
  });

  if (existsSync(join(ROOT, '.data', 'MOVED.json'))) {
    throw new Error('Hệ thống đã chuyển sang máy khác (.data/MOVED.json). Hủy chuyển: node scripts/move-machine.mjs reactivate');
  }
  const env = loadEnv();
  const apps = (env.SERVER_APPS ?? ALL_APPS.join(',')).split(',').map((a) => a.trim()).filter(Boolean);
  const unknown = apps.filter((a) => !ALL_APPS.includes(a));
  if (unknown.length) throw new Error(`SERVER_APPS có tên lạ: ${unknown.join(', ')}`);
  if (apps.includes('web') && !existsSync(join(ROOT, 'apps', 'web', '.next', 'BUILD_ID'))) {
    throw new Error('Chưa build web. Chạy: pnpm build:web');
  }
  const keepDays = Number(env.LOG_KEEP_DAYS ?? 14);
  pruneLogs(keepDays);
  log(`Khởi động SeedingSys (PID ${process.pid}): ${apps.join(', ')}`);

  const pg = await startPostgres(env);
  migrate(env);

  let stopping = false;
  const children = new Map();
  const launch = (app, backoff = 2000) => {
    const { args, cwd, env: childEnv } = appCommand(app, env);
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.set(app, child);
    for (const s of [child.stdout, child.stderr]) {
      s.setEncoding('utf8');
      s.on('data', (d) => d.split('\n').filter((l) => l.trim()).forEach((l) => logLine(app, l.trimEnd())));
    }
    child.on('exit', (code, signal) => {
      if (stopping) return;
      const next = Date.now() - startedAt > 60_000 ? 2000 : Math.min(backoff * 2, 60_000);
      log(`${app} dừng (mã ${code ?? signal}), chạy lại sau ${Math.round(next / 1000)} giây.`);
      setTimeout(() => !stopping && launch(app, next), next);
    });
  };
  for (const app of apps) launch(app);

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    log(`Đang dừng (${why})...`);
    for (const child of children.values()) killTree(child);
    for (let i = 0; i < 20 && [...children.values()].some((c) => c.exitCode === null && c.signalCode === null); i++) await delay(500);
    if (pg) {
      try {
        await pg.stop();
        log('Đã dừng Postgres.');
      } catch (e) {
        log(`Dừng Postgres lỗi: ${e.message}`);
      }
    }
    rmSync(STOP_FILE, { force: true });
    log('Đã dừng.');
    for (const s of streams.values()) s.end();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  setInterval(() => existsSync(STOP_FILE) && shutdown('lệnh stop'), 2000);
  setInterval(() => pruneLogs(keepDays), 86400_000);
}

async function stop() {
  const info = runningSupervisor();
  if (!info) return console.log('SeedingSys không chạy.');
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STOP_FILE, stamp());
  console.log(`Đang dừng SeedingSys (PID ${info.pid})...`);
  for (let i = 0; i < 60; i++) {
    if (!isAlive(info.pid)) return console.log('Đã dừng.');
    await delay(500);
  }
  console.error('Chưa dừng sau 30 giây, xem .data/logs/supervisor-*.log');
  process.exit(1);
}

async function status() {
  const env = loadEnv();
  const info = runningSupervisor();
  console.log(info ? `Đang chạy: PID ${info.pid}, từ ${info.startedAt}` : 'Supervisor: không chạy');
  const webPort = Number(env.WEB_PORT ?? 3000);
  const apiPort = Number(env.API_PORT ?? 3001);
  console.log(`Web  http://localhost:${webPort}: ${(await portOpen(webPort)) ? 'trả lời' : 'không trả lời'}`);
  console.log(`API  127.0.0.1:${apiPort}: ${(await portOpen(apiPort)) ? 'trả lời' : 'không trả lời'}`);
  console.log(`Log: ${LOG_DIR}`);
}

const command = process.argv[2] ?? 'status';
const commands = { start, stop, status };
if (!commands[command]) {
  console.error('Dùng: node scripts/server.mjs start | stop | status');
  process.exit(2);
}
commands[command]().catch((e) => {
  try {
    log(`LỖI: ${e.message}`);
  } catch {}
  console.error(e.message);
  process.exit(1);
});
