// Move a single-machine SeedingSys install (docs/DEPLOY.md §2.1) to another Windows machine.
//
// Old machine:
//   node scripts/move-machine.mjs check            while the system still runs: is it safe to stop? (exit 1 = not yet)
//   node scripts/move-machine.mjs export <dir>     after `pnpm server:stop`: copy DB + .env into <dir> with checksums,
//                                                  then retire this machine (it refuses to start Postgres again)
//   node scripts/move-machine.mjs reactivate       undo the retirement if the move is abandoned
// New machine (after git clone + pnpm install):
//   node scripts/move-machine.mjs import <dir> [--worker-name <name>] [--force]
//
// The package contains .env (API tokens, R2 keys): carry it on a USB drive or similar, never by chat/email.
// Facebook browser profiles are NOT moved: Chrome encrypts cookies per Windows user, so every account
// logs in again on the new machine with `pnpm fb:login <code>`.
// SEEDINGSYS_ROOT overrides the project root (used for testing on a scratch copy).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.env.SEEDINGSYS_ROOT ?? SCRIPT_ROOT);
const DATA = join(ROOT, '.data');
const PG_DIR = join(DATA, 'pg');
const MOVED = join(DATA, 'MOVED.json');
const PID_FILE = join(DATA, 'run', 'supervisor.pid');
const FORMAT = 1;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) fail(`Không thấy ${file}.`);
  return parseEnv(readFileSync(file, 'utf8'));
}

function pgVersionInstalled() {
  return JSON.parse(readFileSync(join(SCRIPT_ROOT, 'node_modules', 'embedded-postgres', 'package.json'), 'utf8')).version;
}

function portOpen(port) {
  return new Promise((done) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1500);
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('timeout', () => (s.destroy(), done(false)));
    s.once('error', () => done(false));
  });
}

function supervisorRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    process.kill(JSON.parse(readFileSync(PID_FILE, 'utf8')).pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function assertStopped(env) {
  const port = Number(new URL(env.DATABASE_URL).port || 5432);
  if (supervisorRunning() || (await portOpen(port))) {
    fail(`SeedingSys/Postgres còn đang chạy (cổng ${port}). Dừng trước: pnpm server:stop (và tắt pnpm db:local / pnpm dev:all nếu có).`);
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function sha256(file) {
  return new Promise((done, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => done(h.digest('hex'))).on('error', reject);
  });
}

function removeAutostart() {
  if (process.platform !== 'win32' || ROOT !== SCRIPT_ROOT) return;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', "if (Get-ScheduledTask -TaskName SeedingSys -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName SeedingSys -Confirm:$false; 'removed' }"], { encoding: 'utf8' });
  if (r.stdout.includes('removed')) console.log('✓ Đã gỡ tác vụ tự khởi động "SeedingSys" trên máy này.');
}

// ───────────────────────── check ─────────────────────────
async function check() {
  const env = loadEnv();
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await db.connect();
  } catch (e) {
    fail(`Không kết nối được DB (${e.message}). Lệnh check chạy khi hệ thống còn đang chạy.`);
  }
  const blockers = [];
  const warnings = [];
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  const global = await q(`SELECT paused FROM controls WHERE scope = 'GLOBAL' AND scope_key = '*'`);
  if (!global[0]?.paused) blockers.push('Chưa bật công tắc dừng toàn hệ thống (trang Công tắc dừng → Toàn hệ thống).');

  const active = await q(`SELECT status::text AS s, count(*)::int AS n FROM publications
    WHERE status::text = ANY($1) GROUP BY 1`, [['PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', 'COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING']]);
  for (const r of active) blockers.push(`${r.n} bài đang đăng dở (${r.s}). Chờ xong.`);
  const unresolved = await q(`SELECT status::text AS s, count(*)::int AS n FROM publications
    WHERE status::text = ANY($1) GROUP BY 1`, [['UNKNOWN', 'RECONCILING', 'NEEDS_OPERATOR']]);
  for (const r of unresolved) warnings.push(`${r.n} bài ${r.s} (Chờ đối chiếu). Nên xử lý xong trên máy này trước khi chuyển.`);

  const sending = await q(`SELECT status::text AS s, count(*)::int AS n FROM publication_comments
    WHERE status::text IN ('SENDING', 'UNKNOWN') GROUP BY 1`);
  for (const r of sending) (r.s === 'SENDING' ? blockers : warnings).push(`${r.n} bình luận ở trạng thái ${r.s}.`);

  const scans = await q(`SELECT count(*)::int AS n FROM comment_scans WHERE status::text = 'RUNNING'`);
  if (scans[0].n) warnings.push(`${scans[0].n} lượt quét bình luận đang chạy.`);

  const leases = await q(`SELECT resource, holder FROM account_leases WHERE released_at IS NULL AND expires_at > now()`);
  for (const l of leases) blockers.push(`Tài khoản ${l.resource} đang bị ${l.holder} giữ (trình duyệt đang làm việc).`);

  try {
    const jobs = await q(`SELECT name, state::text AS s, count(*)::int AS n FROM pgboss.job
      WHERE state::text IN ('active', 'created', 'retry') GROUP BY 1, 2 ORDER BY 1`);
    for (const j of jobs) {
      if (j.s === 'active') blockers.push(`${j.n} việc ${j.name} đang chạy.`);
      else if (j.name.startsWith('publish')) warnings.push(`${j.n} việc ${j.name} đang chờ (${j.s}); sẽ chạy tiếp trên máy mới.`);
    }
  } catch {
    warnings.push('Không đọc được hàng đợi pgboss.job.');
  }
  await db.end();

  for (const w of warnings) console.log(`! ${w}`);
  for (const b of blockers) console.log(`✗ ${b}`);
  if (blockers.length) {
    console.log('\nChưa an toàn để dừng. Chạy lại lệnh check sau ít phút.');
    process.exit(1);
  }
  console.log('\n✓ An toàn để dừng: pnpm server:stop, rồi node scripts/move-machine.mjs export <thư mục>');
}

// ───────────────────────── export ─────────────────────────
async function exportTo(dirArg) {
  if (!dirArg) fail('Thiếu thư mục đích: node scripts/move-machine.mjs export E:\\seedingsys-move');
  const env = loadEnv();
  await assertStopped(env);
  if (!existsSync(join(PG_DIR, 'PG_VERSION'))) fail(`Không thấy database ở ${PG_DIR}.`);
  const out = resolve(dirArg);
  if (existsSync(out) && readdirSync(out).length) fail(`${out} đã có dữ liệu. Chọn thư mục trống.`);
  mkdirSync(out, { recursive: true });

  console.log('Đang chép database...');
  await cp(PG_DIR, join(out, 'pg'), { recursive: true, filter: (src) => !/postmaster\.(pid|opts)$/.test(src) });
  await cp(join(ROOT, '.env'), join(out, 'env'));
  const fake = join(DATA, 'fake-platform.json');
  if (existsSync(fake)) await cp(fake, join(out, 'fake-platform.json'));
  if ((env.STORAGE_DRIVER ?? 'local') === 'local') {
    const objects = resolve(ROOT, env.LOCAL_STORAGE_DIR ?? '.data/objects');
    if (existsSync(objects)) await cp(objects, join(out, 'objects'), { recursive: true });
  }

  console.log('Đang tính checksum...');
  const files = [];
  for (const f of listFiles(out)) {
    files.push({ path: relative(out, f).split(sep).join('/'), size: statSync(f).size, sha256: await sha256(f) });
  }
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || null;
  const manifest = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    from: { host: os.hostname(), platform: process.platform, arch: process.arch, node: process.version },
    embeddedPostgres: pgVersionInstalled(),
    pgVersion: readFileSync(join(PG_DIR, 'PG_VERSION'), 'utf8').trim(),
    git: { commit: git(['rev-parse', 'HEAD']), uncommittedFiles: (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length },
    storageDriver: env.STORAGE_DRIVER ?? 'local',
    workerName: env.WORKER_NAME ?? null,
    files,
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  writeFileSync(MOVED, JSON.stringify({ movedAt: manifest.createdAt, package: out }, null, 2));
  removeAutostart();
  const mb = (files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1);
  console.log(`✓ Đã đóng gói ${files.length} tệp (${mb} MB) vào ${out}`);
  console.log('✓ Máy này đã ngừng: Postgres sẽ không khởi động nữa (.data/MOVED.json). Hủy chuyển: node scripts/move-machine.mjs reactivate');
  if (manifest.git.uncommittedFiles) {
    console.log(`! Code có ${manifest.git.uncommittedFiles} tệp chưa commit. Máy mới clone repo sẽ KHÔNG có các thay đổi này. Commit và push trước khi cài máy mới.`);
  }
  console.log('! Gói chứa .env (mã đăng nhập, khóa R2): chuyển bằng USB, không gửi qua chat/email; xóa gói sau khi máy mới chạy ổn.');
}

function reactivate() {
  if (!existsSync(MOVED)) return console.log('Máy này chưa bị đánh dấu đã chuyển.');
  rmSync(MOVED);
  console.log('✓ Đã bỏ đánh dấu. Chạy lại: pnpm server:start; cài lại tự khởi động bằng scripts\\windows\\install-autostart.ps1');
  console.log('! Đảm bảo máy mới KHÔNG chạy cùng lúc, nếu không sẽ đăng trùng bài.');
}

// ───────────────────────── import ─────────────────────────
async function importFrom(dirArg, flags) {
  if (!dirArg) fail('Thiếu thư mục gói: node scripts/move-machine.mjs import E:\\seedingsys-move');
  const src = resolve(dirArg);
  const manifestFile = join(src, 'manifest.json');
  if (!existsSync(manifestFile)) fail(`Không thấy ${manifestFile}.`);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (m.format !== FORMAT) fail(`Gói định dạng ${m.format}, script này đọc định dạng ${FORMAT}.`);

  if (m.from.platform !== process.platform || m.from.arch !== process.arch) {
    fail(`Gói tạo trên ${m.from.platform}/${m.from.arch}, máy này là ${process.platform}/${process.arch}. Thư mục Postgres chỉ chép được giữa cùng nền tảng.`);
  }
  const installed = pgVersionInstalled();
  if (installed !== m.embeddedPostgres) {
    fail(`embedded-postgres ${installed} khác bản trong gói (${m.embeddedPostgres}). Checkout đúng commit/pnpm-lock.yaml rồi pnpm install.`);
  }
  const localCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
  if (m.git.commit && localCommit && localCommit !== m.git.commit) {
    console.log(`! Code ở đây (${localCommit.slice(0, 7)}) khác máy cũ (${m.git.commit.slice(0, 7)}). Migration mới hơn sẽ tự chạy; code cũ hơn DB thì không chạy được.`);
  }

  console.log('Đang kiểm tra checksum...');
  for (const f of m.files) {
    const p = join(src, f.path);
    if (!existsSync(p)) fail(`Gói thiếu tệp ${f.path}.`);
    if (statSync(p).size !== f.size || (await sha256(p)) !== f.sha256) fail(`Tệp ${f.path} bị hỏng khi chép. Chép lại gói.`);
  }

  if (existsSync(join(ROOT, '.env'))) await assertStopped(loadEnv());
  const keep = (p) => {
    if (!existsSync(p)) return;
    if (!flags.force) fail(`${p} đã tồn tại. Thêm --force để cất bản cũ sang tên khác rồi nhập.`);
    const moved = `${p}.before-import-${stamp()}`;
    renameSync(p, moved);
    console.log(`  bản cũ → ${moved}`);
  };
  keep(PG_DIR);
  keep(join(ROOT, '.env'));
  mkdirSync(DATA, { recursive: true });

  await cp(join(src, 'pg'), PG_DIR, { recursive: true });
  let envText = readFileSync(join(src, 'env'), 'utf8');
  if (flags.workerName) {
    envText = /^WORKER_NAME=.*$/m.test(envText)
      ? envText.replace(/^WORKER_NAME=.*$/m, `WORKER_NAME=${flags.workerName}`)
      : `${envText.trimEnd()}\nWORKER_NAME=${flags.workerName}\n`;
  }
  writeFileSync(join(ROOT, '.env'), envText);
  if (existsSync(join(src, 'fake-platform.json'))) await cp(join(src, 'fake-platform.json'), join(DATA, 'fake-platform.json'));
  const env = parseEnv(envText);
  if (existsSync(join(src, 'objects'))) {
    await cp(join(src, 'objects'), resolve(ROOT, env.LOCAL_STORAGE_DIR ?? '.data/objects'), { recursive: true });
  }
  if (existsSync(MOVED)) rmSync(MOVED);

  console.log(`✓ Đã nhập database và .env từ ${m.from.host} (đóng gói ${m.createdAt}).`);
  if (!flags.workerName && env.WORKER_NAME === m.workerName) {
    console.log(`! WORKER_NAME vẫn là "${env.WORKER_NAME}" như máy cũ. Nên đặt tên mới (--worker-name) để dashboard phân biệt.`);
  }
  if (env.FB_PROFILES_DIR && !existsSync(env.FB_PROFILES_DIR)) {
    console.log(`! Thư mục profile Facebook ${env.FB_PROFILES_DIR} chưa có trên máy này; fb:login sẽ tạo. Nên đặt trên ổ có BitLocker.`);
  }
  console.log('\nTiếp theo:');
  console.log('  1. pnpm build:web');
  console.log('  2. pnpm server:start            (để cửa sổ mở, xem log; kiểm tra dashboard)');
  console.log('  3. pnpm fb:login <mã>           cho TỪNG tài khoản nguồn/đích dùng fb-web (phiên Facebook không chuyển theo)');
  console.log('  4. Tắt dần công tắc dừng từng tài khoản trên trang Công tắc dừng');
  console.log('  5. Ctrl+C, rồi cài tự khởi động: powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-autostart.ps1');
}

const [command, dir, ...rest] = process.argv.slice(2);
const flags = { force: rest.includes('--force') || dir === '--force' };
const wi = rest.indexOf('--worker-name');
if (wi >= 0) flags.workerName = rest[wi + 1];
if (flags.workerName !== undefined && !/^[\w.-]+$/.test(flags.workerName ?? '')) fail('--worker-name chỉ gồm chữ, số, dấu chấm, gạch.');

const run = { check: () => check(), export: () => exportTo(dir), import: () => importFrom(dir, flags), reactivate: () => reactivate() }[command];
if (!run) {
  console.error('Dùng: node scripts/move-machine.mjs check | export <thư mục> | import <thư mục> [--worker-name <tên>] [--force] | reactivate');
  process.exit(2);
}
await run();
