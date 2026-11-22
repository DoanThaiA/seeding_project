/**
 * Capability test for the fb-web connector on a REAL account, in "Chỉ mình tôi" mode.
 *   pnpm fb:capability B1 --yes                       # TEXT, SINGLE_PHOTO, MULTI_PHOTO x 20 cases
 *   pnpm fb:capability B1 --formats TEXT --cases 3 --yes
 *   pnpm fb:capability B1 --formats VIDEO --video C:\clip.mp4 --yes
 *   add --activate to mark the connector release active when at least one format passed
 *
 * It publishes real test posts visible only to the account owner (they are NOT deleted
 * automatically: delete them by hand afterwards). It refuses to run unless the target's audience
 * is ONLY_ME, and stops at the first checkpoint / logged-out / wrong identity / unclear result.
 * Results are written to capability_checks; only formats with >= 20 cases and the required pass
 * rate are marked passed. Stop worker-browser first (a profile can be open in one browser only).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@seedingsys/config';
import { FB_WEB_VERSION, FbWebPublishConnector, IMPLEMENTED_FORMATS, MIN_CASES, fbWebOptionsFromEnv, runCapability } from '@seedingsys/connectors-fb-web';
import type { ContentType } from '@seedingsys/contracts';
import { createDb } from '@seedingsys/db';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

async function main() {
  const code = process.argv[2];
  if (!code || code.startsWith('--')) throw new Error('usage: pnpm fb:capability <B code> [--formats A,B] [--cases N] [--video file] [--pause-sec N] [--activate] --yes');
  const cases = Number(arg('cases', String(MIN_CASES)));
  const pause = Number(arg('pause-sec', '60'));
  const formats = (arg('formats', 'TEXT,SINGLE_PHOTO,MULTI_PHOTO') as string).split(',').map((s) => s.trim().toUpperCase()) as ContentType[];
  const bad = formats.filter((f) => !IMPLEMENTED_FORMATS.includes(f));
  if (bad.length) throw new Error(`Định dạng không có flow: ${bad.join(', ')}`);

  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const t = await db.targetAccount.findUnique({ where: { code }, include: { profile: true } });
  if (!t) throw new Error(`Không có tài khoản đích ${code}`);
  if (t.connector !== 'fb-web') throw new Error(`${code} đang dùng connector "${t.connector}", không phải fb-web`);
  if (t.audience !== 'ONLY_ME') throw new Error(`${code} có đối tượng xem ${t.audience}. Đặt về "Chỉ mình tôi" (ONLY_ME) trước khi thử.`);

  const total = formats.length * cases;
  console.log(`Sẽ đăng ${total} bài THỬ lên ${code} (${formats.join(', ')} x ${cases}), cách nhau ${pause}s, khoảng ${Math.round((total * pause) / 60)} phút.`);
  console.log('Bài chỉ mình bạn thấy nhưng KHÔNG tự xóa; bạn cần xóa tay sau đó.');
  if (!process.argv.includes('--yes')) {
    console.log('\nThêm --yes để xác nhận chạy.');
    process.exit(2);
  }

  const opts = { ...fbWebOptionsFromEnv(), headless: arg('headless') === 'true', enabledFormats: formats };
  const connector = new FbWebPublishConnector(opts);
  const target = { id: t.id, code: t.code, externalId: t.externalId, audience: t.audience, uiLocale: t.uiLocale, profileDir: t.profile?.profileDir };
  const results = await runCapability({
    connector,
    target,
    formats,
    casesPerFormat: cases,
    pauseMs: pause * 1000,
    workDir: join(tmpdir(), 'seedingsys-capability'),
    videoPath: arg('video'),
    log: (m) => console.log(m),
  });

  let anyPassed = false;
  console.log('\nKết quả:');
  for (const r of results) {
    anyPassed ||= r.passed;
    const note = r.aborted ? `  (dừng: ${r.aborted})` : !r.passed && r.cases < MIN_CASES ? `  (cần >= ${MIN_CASES} ca để chứng nhận)` : '';
    console.log(`  ${r.format.padEnd(13)} ${r.cases - r.failures}/${r.cases}  ngưỡng ${Math.round(r.threshold * 100)}%  ${r.passed ? 'ĐẠT' : 'CHƯA ĐẠT'}${note}`);
    await db.capabilityCheck.upsert({
      where: { targetId_contentType_connector_connectorVersion: { targetId: t.id, contentType: r.format, connector: 'fb-web', connectorVersion: FB_WEB_VERSION } },
      create: { targetId: t.id, contentType: r.format, connector: 'fb-web', connectorVersion: FB_WEB_VERSION, passed: r.passed, cases: r.cases, failures: r.failures, notes: r.aborted ?? null },
      update: { passed: r.passed, cases: r.cases, failures: r.failures, notes: r.aborted ?? null, checkedAt: new Date() },
    });
  }
  const activate = process.argv.includes('--activate') && anyPassed;
  await db.connectorRelease.upsert({
    where: { connector_version: { connector: 'fb-web', version: FB_WEB_VERSION } },
    create: { connector: 'fb-web', version: FB_WEB_VERSION, active: activate, notes: 'selectors vi-VN' },
    update: activate ? { active: true } : {},
  });
  const passed = results.filter((r) => r.passed).map((r) => r.format);
  console.log(passed.length ? `\nĐịnh dạng đã đạt kiểm thử: ${passed.join(', ')}` : '\nLượt kiểm thử chưa có định dạng đạt.');
  console.log('Nhớ xóa tay các bài thử "[SeedingSys capability test ...]" trên tài khoản.');
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
