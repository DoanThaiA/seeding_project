/**
 * Open a VISIBLE browser on an account's dedicated profile so a person can log in by hand.
 *   pnpm fb:login B1     → target account (the one that posts)
 *   pnpm fb:login A1     → source account (whose OWN profile is read)
 * - Log in yourself (password, 2-step, any security check). Nothing here automates the login.
 * - Stop the app (dev:all / worker-browser) first: a profile can only be open in one browser at a time.
 * - Keep the interface language Vietnamese (vi-VN), then close the window when done.
 */
import { loadConfig } from '@seedingsys/config';
import { FbWebPublishConnector, fbWebOptionsFromEnv } from '@seedingsys/connectors-fb-web';
import { createDb } from '@seedingsys/db';

async function main() {
  const code = (process.argv[2] ?? '').toUpperCase();
  if (!code) throw new Error('usage: pnpm fb:login <A1|B1|…>');
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const connector = new FbWebPublishConnector(fbWebOptionsFromEnv());

  let ref: { id: string; code: string; externalId: string; audience: string; uiLocale: string; profileDir?: string };
  if (code.startsWith('A')) {
    const s = await db.source.findUnique({ where: { code } });
    if (!s) throw new Error(`Không có nguồn ${code}`);
    ref = { id: s.id, code: s.code, externalId: s.externalRef, audience: 'ONLY_ME', uiLocale: 'vi-VN', profileDir: s.code };
    console.log(`Nguồn ${code}: đăng nhập ĐÚNG tài khoản có trang cá nhân ${s.externalRef} (hệ thống chỉ đọc trang của chính tài khoản đăng nhập).`);
  } else {
    const t = await db.targetAccount.findUnique({ where: { code }, include: { profile: true } });
    if (!t) throw new Error(`Không có tài khoản đích ${code}`);
    ref = { id: t.id, code: t.code, externalId: t.externalId, audience: t.audience, uiLocale: t.uiLocale, profileDir: t.profile?.profileDir };
    console.log(`Tài khoản đích ${code}: đăng nhập tài khoản có ID ${t.externalId}.`);
  }
  console.log(`Profile: ${connector.profilePath(ref)}\nĐăng nhập trong cửa sổ trình duyệt vừa mở, rồi ĐÓNG cửa sổ.`);
  const { closed } = await connector.openForManualLogin(ref);
  await closed;
  await db.$disconnect();
  console.log('Đã đóng.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
