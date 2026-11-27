import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FbWebPublishConnector } from '@seedingsys/connectors-fb-web';

const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
describe.skipIf(!executablePath)('thu thập hồ sơ bạn bè', () => {
  const paths: string[] = [];
  const card = (name: string) => '<div><a href="/' + name + '"><img alt="avatar" /></a><a href="/' + name + '">' + name + '</a></div>';
  const server = createServer((req, res) => {
    paths.push(req.url!);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const content = req.url === '/source/friends' ? '<section><h2>Tất cả bạn bè</h2>' + card('Lan') + card('Lan') + card('Minh') + '</section>'
      : req.url === '/hidden/friends' ? '<section><h2>Bạn chung</h2>' + card('Minh') + '</section>'
      : req.url === '/Minh/about_contact_and_basic_info' ? '<article><span>1999</span><span>Năm sinh</span><span>300 followers</span></article>'
      : '<span>1992</span><span>Năm sinh</span><span>1,2 nghìn người theo dõi</span><article><span>1998</span><span>Năm sinh</span></article>';
    res.end('<main>' + content + '</main>');
  });
  let session: Awaited<ReturnType<FbWebPublishConnector['openSession']>>;
  let dir: string;
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port');
    dir = mkdtempSync(join(tmpdir(), 'friend-profiles-'));
    const connector = new FbWebPublishConnector({ baseUrl: 'http://127.0.0.1:' + address.port, profilesRoot: dir,
      headless: true, executablePath, enabledFormats: [], stepTimeoutMs: 8000, uploadTimeoutMs: 8000 });
    session = await connector.openSession({ id: 'target', code: 'B1', externalId: '1', audience: 'ONLY_ME', uiLocale: 'vi-VN' });
  });
  afterAll(async () => {
    await session?.close(); server.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  it('giới hạn kết quả và chỉ mở mục giới thiệu', async () => {
    let result: unknown;
    const outcome = await session.scanFriends('https://www.facebook.com/source', 1, async rows => { result = rows; });
    expect(outcome.status).toBe('DONE');
    expect(result).toEqual([{ name: 'Lan', url: 'https://www.facebook.com/Lan', followers: '1,2 nghìn', score: 3, birthYear: 1992 }]);
    expect(paths.filter(path => path.includes('about'))).toEqual(['/Lan/about_contact_and_basic_info']);
  });
  it('gộp hồ sơ trùng và giữ trống các trường chỉ có trong bài viết', async () => {
    let result: unknown;
    await session.scanFriends('https://www.facebook.com/source', 2, async rows => { result = rows; });
    expect(result).toEqual([expect.objectContaining({ name: 'Lan' }), { name: 'Minh', url: 'https://www.facebook.com/Minh', followers: null, score: 1, birthYear: null }]);
  });
  it('bỏ qua khi Facebook chỉ hiển thị bạn chung', async () => {
    paths.length = 0;
    expect((await session.scanFriends('https://www.facebook.com/hidden', 10, async () => { throw new Error('unexpected friend'); })).status).toBe('SKIPPED');
    expect(paths.some(path => path.includes('about'))).toBe(false);
  });
});
