import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny stand-in for the Facebook web UI used ONLY to test the fb-web connector code.
 * It reproduces the structure that packages/connectors/fb-web/src/selectors.ts expects (roles +
 * visible names in vi-VN). It proves the connector logic works; it does NOT prove the selectors
 * match the real Facebook — that is what the capability test on the live UI is for.
 */
export interface MockPost {
  id: string;
  caption: string;
  media: number;
  video: boolean;
  photoId?: string;
  previewFixture?: boolean;
  timelineCaptionHtml?: string;
  omitPhotoAttachment?: boolean;
  photoReceiptAfterReload?: boolean;
  storyAlias?: string;
  albumPhotos?: string[];
  reel?: boolean;
  audience: string;
  at: number;
  processing?: boolean;
  /** Override the relative-time text (e.g. to simulate an unreadable timestamp). */
  timeText?: string;
  /** New posts on the real profile: timestamp link has href="#" and no text until hovered. */
  hiddenTime?: boolean;
  /** Like the real profile: obfuscated timestamp text, href="#" until the pointer reaches it. */
  lazyHref?: boolean;
  /** Video post: the player is wrapped in a link to this path (e.g. /reel/123), like the real profile. */
  videoHref?: string;
}

export class MockFb {
  session: 'OK' | 'LOGGED_OUT' | 'CHECKPOINT' = 'OK';
  userId = '100012345';
  vanity: string | null = null;
  defaultAudience = 'Chỉ mình tôi';
  audienceLocked = false; // composer refuses to change the audience
  mangleCaption = false; // composer drops the last character (simulates a broken editor)
  postMode: 'normal' | 'drop' | 'noclose' = 'normal';
  toast = true;
  reelViaMenu = false;
  /** Real UI: comment links point at a pfbid form of the post id (and carry tracking params). */
  pfbidCommentLinks = false;
  /** Real UI: a reply renders inside its parent's comment card, Reply button included. */
  nestedReplies = false;
  directReplyLabel = 'Viết phản hồi';
  /** Real UI: comment links on a photo point at the photo's story by a pfbid id. */
  pfbidPhotoStory = false;
  /** Real UI: comment links use a pfbid absent from the page data; an encoded profile link names the numeric post. */
  rotatingPfbid = false;
  commentReceiptMode: 'normal' | 'profile-link' | 'related-post' | 'wrong-author' | 'wrong-text' = 'normal';
  posts: MockPost[] = [];
  artwork?: { avatar: string; cover: string | null };
  artworkSaves: Array<{ kind: 'avatar' | 'cover'; name: string; size: number; share: boolean }> = [];
  bio?: string;
  comments: Array<{ postId: string; id: string; parentId?: string; rootId?: string; text: string }> = [];
  private n = 0;
  private server!: Server;
  baseUrl = '';

  constructor(private readonly now: () => number = () => Date.now()) {}

  addPost(p: Partial<MockPost> & { caption: string }): MockPost {
    const post: MockPost = { id: `p${++this.n}`, media: 0, video: false, audience: 'Chỉ mình tôi', at: this.now(), ...p };
    this.posts.push(post);
    return post;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private rel(p: MockPost): string {
    if (p.timeText) return p.timeText;
    const s = Math.max(0, Math.round((this.now() - p.at) / 1000));
    if (s < 60) return 'Vừa xong';
    if (s < 3600) return `${Math.round(s / 60)} phút`;
    if (s < 86400) return `${Math.round(s / 3600)} giờ`;
    return `${Math.round(s / 86400)} ngày`;
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': type, ...extra });
      res.end(body);
    };
    if (url.pathname === '/__post' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw) as { caption: string; media: number; video: boolean; audience: string; reel?: boolean };
      if (this.postMode === 'normal') this.addPost(b);
      return send(200, JSON.stringify({ ok: true, close: this.postMode !== 'noclose', id: `p${this.n}`, toast: this.toast }), 'application/json');
    }
    if (url.pathname === '/login/' || url.pathname === '/checkpoint/') {
      return send(200, url.pathname === '/login/' ? '<form><input name="email"><input type="password" name="pass"><button>Đăng nhập</button></form>' : '<h1>Xác nhận danh tính của bạn</h1>');
    }
    if (this.session === 'LOGGED_OUT') return send(302, '', 'text/plain', { location: '/login/' });
    if (this.session === 'CHECKPOINT') return send(302, '', 'text/plain', { location: '/checkpoint/' });
    if (url.pathname === '/me') return send(302, '', 'text/plain', { location: this.vanity ? `/${this.vanity}` : `/profile.php?id=${this.userId}` });
    if (this.bio !== undefined && url.pathname === '/__bio' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      this.bio = JSON.parse(raw).bio;
      return send(200, '{}', 'application/json');
    }
    if (this.bio !== undefined && url.pathname === '/profile.php' && url.searchParams.get('id') === this.userId) {
      const section = url.searchParams.get('sk');
      if (section === 'about') return send(200, '<main><section><h2>Thông tin cá nhân</h2><div>Thông tin hiển thị</div></section></main>');
      if (section === 'about_work_and_education') return send(200, '<main><h1>Hồ sơ thử nghiệm</h1><section><h2>Công việc</h2><div>Công việc hiển thị</div><div hidden>Công việc ẩn</div></section></main>');
      if (section) return send(200, '<main><h1>Hồ sơ thử nghiệm</h1><section><h2>Mục khác</h2></section></main>');
      return send(200, `<main><h2><a href="/profile.php?id=${esc(this.userId)}">Hồ sơ thử nghiệm</a></h2><section><h2>Giới thiệu</h2>
        ${this.bio ? `<div dir="auto"><span dir="auto">${esc(this.bio)}</span></div>` : ''}
        <button id="edit">${this.bio ? 'Chỉnh sửa tiểu sử' : 'Thêm tiểu sử'}</button>
        <ul><li>Sống tại Huế</li><li hidden>Mục không hiển thị</li></ul>
        <div role="dialog" hidden><textarea aria-label="Tiểu sử"></textarea><button id="save">Lưu</button></div>
        <script>
          document.querySelector('#edit').onclick = () => { document.querySelector('[role="dialog"]').hidden = false; };
          document.querySelector('#save').onclick = async () => {
            await fetch('/__bio', { method: 'POST', body: JSON.stringify({ bio: document.querySelector('textarea').value }) });
            location.reload();
          };
        </script></section><article>Bài trên bảng tin</article></main>`);
    }
    if (this.artwork && url.pathname === '/__artwork' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const saved = JSON.parse(raw) as typeof this.artworkSaves[number];
      this.artworkSaves.push(saved);
      this.artwork[saved.kind] = String(900 + this.artworkSaves.length);
      return send(200, '{}', 'application/json');
    }
    if (this.artwork && url.pathname === '/profile.php' && url.searchParams.get('id') === this.userId) return send(200, this.artworkPage());
    if (this.artwork && url.pathname === '/photo/' && Object.values(this.artwork).includes(url.searchParams.get('fbid') ?? '')) {
      const id = url.searchParams.get('fbid');
      const photo = { id, owner: { id: this.userId }, image: { uri: this.baseUrl + '/fixture.png', width: 50, height: 100 } };
      return send(200, `<script type="application/json">${JSON.stringify(photo)}</script>`);
    }
    if (url.pathname === '/notifications') {
      return send(200, `<!doctype html><html><body>${this.posts.filter(p => p.reel).map(p =>
        `<a href="/reel/${p.id}">Chưa đọc Bạn có thể xem thước phim rồi. Hãy chia sẻ với bạn bè nhé. ${this.rel(p)}</a>`).join('')}</body></html>`);
    }
    if (url.pathname === '/') return send(200, this.home());
    if (url.pathname === '/reels/create') return send(200, this.home(true));
    const photoViewer = url.pathname === '/photo' || url.pathname === '/photo/';
    const post = this.posts.find(p => url.pathname === (p.reel ? '/reel/' : '/posts/') + p.id ||
      (photoViewer && p.photoId && url.searchParams.get('fbid') === p.photoId) ||
      (url.pathname === '/permalink.php' && [p.id, p.storyAlias, 'pfbid0Story' + p.id].includes(url.searchParams.get('story_fbid') ?? '')));
    if (post && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { text, parentId } = JSON.parse(raw);
      const parent = this.comments.find(comment => comment.postId === post.id && comment.id === parentId);
      const comment = { postId: post.id, id: 'c' + (this.comments.length + 1), text, parentId, rootId: parent?.rootId ?? parent?.id };
      this.comments.push(comment);
      return send(200, JSON.stringify(comment), 'application/json');
    }
    if (post) return send(200, this.postPage(post, photoViewer, !!post.storyAlias && url.searchParams.get('story_fbid') === post.storyAlias));
    return send(200, this.timeline()); // /profile.php?id=… and /<vanity>
  }

  private artworkPage() {
    const header = { id: this.userId, profilePhoto: { id: this.artwork!.avatar },
      cover_photo: this.artwork!.cover ? { photo: { id: this.artwork!.cover } } : null };
    return `<main><h1>Hồ sơ thử nghiệm</h1>
      <button id="avatar-actions">Hành động với ảnh đại diện</button>
      <button id="choose" hidden>Chọn ảnh đại diện</button>
      <button id="cover-actions">Chỉnh sửa ảnh bìa</button>
      <div id="menu" role="menu" hidden><button id="cover-upload" role="menuitem">Tải ảnh lên</button></div>
      <div id="dialog" role="dialog" aria-label="Chọn ảnh đại diện" hidden>
        <button id="avatar-upload">Tải ảnh lên</button>
        <label id="share-label" hidden><input id="share" type="checkbox" checked>Chia sẻ bản cập nhật của bạn lên Bảng feed</label>
        <button id="save-avatar" hidden>Lưu</button>
      </div>
      <button id="save-cover" hidden>Lưu thay đổi</button>
      <input id="file" type="file" hidden>
      <script type="application/json">${JSON.stringify(header)}</script>
      <script>
        const el = id => document.getElementById(id);
        let kind = '';
        el('avatar-actions').onclick = () => el('choose').hidden = false;
        el('choose').onclick = () => { el('choose').hidden = true; el('dialog').hidden = false; };
        el('cover-actions').onclick = () => el('menu').hidden = false;
        el('avatar-upload').onclick = () => { kind = 'avatar'; el('file').click(); };
        el('cover-upload').onclick = () => { kind = 'cover'; el('menu').hidden = true; el('file').click(); };
        el('file').onchange = () => {
          el('save-' + kind).hidden = false;
          if (kind === 'avatar') el('share-label').hidden = false;
        };
        const save = async () => {
          const file = el('file').files[0];
          await fetch('/__artwork', { method: 'POST', body: JSON.stringify({
            kind, name: file.name, size: file.size, share: kind === 'avatar' && el('share').checked,
          }) });
          location.reload();
        };
        el('save-avatar').onclick = save;
        el('save-cover').onclick = save;
      </script></main>`;
  }

  private postPage(post: MockPost, photoViewer: boolean, alternateStory: boolean) {
    const items = this.comments.filter(c => c.postId === post.id);
    const alternatePath = `/tester/posts/pfbid0Zz${post.id}`;
    const story = photoViewer && this.pfbidPhotoStory ? 'pfbid0Story' + post.id : post.storyAlias ?? post.id;
    const commentPath = photoViewer || post.storyAlias ? JSON.stringify(`/permalink.php?story_fbid=${story}&id=${this.userId}`)
      : this.commentReceiptMode === 'related-post' ? JSON.stringify('/other/posts/pfbidWRONG')
      : this.rotatingPfbid ? JSON.stringify(`/permalink.php?story_fbid=pfbid0Rot${post.id}&id=${this.userId}`)
      : this.pfbidCommentLinks ? JSON.stringify(alternatePath) : 'location.pathname';
    const authorPath = this.commentReceiptMode === 'wrong-author' ? '/profile.php?id=999' : this.vanity ? `/${this.vanity}` : `/profile.php?id=${this.userId}`;
    const preview = post.previewFixture && (photoViewer
      ? `<script type="application/json">${JSON.stringify({ result: { data: {
        id: post.photoId, __typename: 'Photo', owner: { name: 'Hồ sơ thử nghiệm' }, message: post.caption ? { text: post.caption } : null,
      } } })}</script>`
      : post.storyAlias ? `<script type="application/json">${JSON.stringify({ result: { data: { node_v2: {
        __typename: 'Story', post_id: post.id, permalink_url: `/permalink.php?story_fbid=${post.storyAlias}&id=${this.userId}`,
        actors: [{ name: 'Hồ sơ thử nghiệm' }], message: { text: post.caption },
      } } } })}</script>` : `<article data-post="${post.id}"><h2><a href="${authorPath}">Hồ sơ thử nghiệm</a></h2>
        <p data-testid="post_message" style="white-space:pre-wrap">${esc(post.caption)}</p></article><article data-post="related"><p data-testid="post_message">Bài gợi ý</p></article>`);
    return `<main>${preview || `<p>${esc(post.caption)}</p>`}${post.video ? '<video style="width:120px;height:160px"></video>' : ''}
      ${!photoViewer && post.photoId && !post.omitPhotoAttachment ? `<a href="/photo/?fbid=${post.photoId}">Ảnh của bài viết</a>` : ''}
      ${post.albumPhotos?.map(id => `<a href="/photo/?fbid=${id}&amp;set=pcb.${post.id}">Ảnh album</a>`).join('') ?? ''}
      ${post.albumPhotos ? `<a href="/photo/?fbid=${alternateStory ? '991' : '992'}">Ảnh đề xuất</a>` : ''}
      <section id="comments"></section><textarea aria-label="Viết bình luận"></textarea>
      ${this.pfbidCommentLinks ? `<script type="application/json">${JSON.stringify({ result: { data: { node_v2: {
        id: post.id, permalink_url: alternatePath, comet_sections: { content: { story: {} } },
      } } } })}</script>` : ''}
      <script>
        const comments = document.querySelector('#comments');
        const editor = document.querySelector('textarea');
        let parentId;
        function add(comment) {
          const article = document.createElement('article');
          const text = document.createElement('div');
          text.setAttribute('data-comment-text', '');
          text.textContent = comment.text${this.commentReceiptMode === 'wrong-text' ? " + ' sai'" : ''};
          const author = document.createElement('a');
          author.href = ${JSON.stringify(authorPath)};
          author.textContent = 'Tác giả';
          ${this.commentReceiptMode === 'profile-link' ? "author.setAttribute('role', 'link');" : "author.setAttribute('data-comment-author', '');"}
          const link = document.createElement('a');
          ${this.rotatingPfbid ? `const encoded = document.createElement('a');
          encoded.href = '/profile.php?id=${this.userId}&comment_id=' + encodeURIComponent(btoa('comment:${post.id}_' + comment.id));
          article.append(encoded);` : ''}
          link.href = ${commentPath} + '${photoViewer || post.storyAlias || this.rotatingPfbid ? '&' : '?'}comment_id=' + (comment.rootId || comment.id) + (comment.parentId ? '&reply_comment_id=' + comment.id : '')${this.pfbidCommentLinks ? " + '&__cft__[0]=z'" : ''};
          link.textContent = 'Vừa xong';
          const reply = document.createElement('button');
          reply.textContent = 'Phản hồi';
          reply.onclick = () => { parentId = comment.id; editor.setAttribute('aria-label', ${JSON.stringify(this.directReplyLabel)}); editor.focus(); };
          article.append(author, text, link, reply);
          ${photoViewer && post.photoReceiptAfterReload ? `
          text.textContent = comment.text.slice(0, 8);
          const more = document.createElement('button');
          more.textContent = 'Xem thêm';
          more.onclick = () => { text.textContent = comment.text; more.remove(); };
          article.append(more);` : ''}
          article.dataset.mockComment = comment.id;
          const host = ${this.nestedReplies} && comment.parentId && document.querySelector('[data-mock-comment="' + comment.parentId + '"]');
          (host || comments).append(article);
        }
        const saved = ${JSON.stringify(items).replace(/</g, '\\u003c')};
        ${photoViewer && post.photoReceiptAfterReload ? 'setTimeout(() => saved.forEach(add), 550);' : 'saved.forEach(add);'}
        editor.onkeydown = async e => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          const response = await fetch(location.pathname + location.search, { method: 'POST', body: JSON.stringify({ text: editor.value, parentId }) });
          const comment = await response.json();
          ${photoViewer && post.photoReceiptAfterReload ? '' : 'add(comment);'}
          editor.value = '';
        };
      </script></main>`;
  }

  private timeline(): string {
    const notices = this.posts.filter(p => p.reel).map(p =>
      `<a hidden href="/reel/${p.id}">Bạn có thể xem thước phim rồi. Hãy chia sẻ với bạn bè nhé.<span>${this.rel(p)}</span></a>`).join('');
    const items = [...this.posts]
      .sort((a, b) => b.at - a.at)
      .map((p) => {
        const player = '<video src="data:video/mp4;base64,AAAA"></video>';
        const media = p.video ? (p.videoHref ? `<a href="${p.videoHref}?__cft__[0]=x">${player}</a>` : player) : Array.from({ length: p.media }, (_, i) => `<a href="/photo?fbid=${p.id}_${i}"><img alt="" style="width:80px;height:80px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a>`).join('');
        const message = p.timelineCaptionHtml ? `<div data-ad-preview="message">${p.timelineCaptionHtml}</div>` : `<div>${esc(p.caption)}</div>`;
        return `<div data-post="1"><h3>Tester</h3>${p.hiddenTime ? '<a href="#"></a>' : p.lazyHref ? `<a href="?__cft__[0]=x" onmouseover="this.setAttribute('href','/posts/${p.id}?__cft__[0]=x')">dSnoprteos</a>` : `<a href="/${p.reel ? 'reel' : 'posts'}/${p.id}">${this.rel(p)}</a>`}${message}${p.processing ? '<div>Video đang được xử lý</div>' : ''}${media}</div>`;
      })
      .join('');
    // Like the real profile page: empty placeholder articles first, a long intro section, and the
    // posts only get rendered once the page is scrolled down.
    return `<!doctype html><html><body><h1>Tester</h1>${notices}<div role="article"></div><div role="article"></div><div style="height:1600px">Giới thiệu, bạn bè…</div><div id="posts"></div><div style="height:1500px"></div><script>const html=${JSON.stringify(items)};let done=false;const f=()=>{if(!done&&window.scrollY>400){done=true;document.getElementById('posts').innerHTML=html;}};addEventListener('scroll',f);f();</script></body></html>`;
  }

  private home(reel = false): string {
    const title = reel ? 'Tạo thước phim' : 'Tạo bài viết';
    return `<!doctype html><html lang="vi"><body>
<div role="button" tabindex="0" id="open">Tester ơi, bạn đang nghĩ gì thế?</div>
<a href="/reel/">Thước phim</a>
${this.reelViaMenu
  ? '<button id="createMenu">Menu trên Facebook</button><button id="menuReel" hidden>Thước phim</button><article><button>Menu</button></article>'
  : '<a href="/reels/create">Tạo thước phim</a>'}
<div role="dialog" aria-label="${title}" id="dlg" ${reel ? '' : 'hidden'}>
  <h2 id="composerTitle">${title}</h2>
  <img alt="" style="width:40px;height:40px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
  <div role="textbox" contenteditable="true" aria-label="${reel ? 'Nhập mô tả' : 'Bạn đang nghĩ gì?'}" id="tb" style="min-height:40px;border:1px solid #ccc" ${reel ? 'hidden' : ''}></div>
  ${reel ? '<button id="next" disabled>Tiếp theo</button>' : ''}
  <button id="aud" ${reel && this.reelViaMenu ? '' : `aria-label="Chỉnh sửa quyền riêng tư. Đối tượng: ${this.defaultAudience}"`}>${reel && this.reelViaMenu ? reelChip(this.defaultAudience) : this.defaultAudience}</button>
  <button id="addm" aria-label="Ảnh/video"><img alt="" style="width:24px;height:24px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></button>
  <input type="file" multiple accept="image/*,video/*" id="file" hidden>
  <div id="thumbs"></div>
  <button id="post" disabled>${reel ? 'Chia sẻ thước phim' : 'Đăng'}</button>
  <button aria-label="Đóng" id="close">×</button>
</div>
<div role="dialog" aria-label="Chọn đối tượng" id="audp" hidden>
  <div role="radio" tabindex="0" aria-label="Công khai" data-v="Công khai">Công khai</div>
  <div role="radio" tabindex="0" aria-label="Bạn bè" data-v="Bạn bè">Bạn bè</div>
  <div role="${reel && this.reelViaMenu ? 'none' : 'radio'}" tabindex="0" aria-label="Chỉ mình tôi" data-v="Chỉ mình tôi">Chỉ mình tôi</div>
  <button id="audok">Xong</button>
</div>
<div role="dialog" aria-label="Bỏ bài viết?" id="disc" hidden><button id="discok">Bỏ bài viết</button></div>
<div id="toast"></div>
<script>
const $=(i)=>document.getElementById(i); let audience=${JSON.stringify(this.defaultAudience)}; let pending=audience; let files=[]; const locked=${this.audienceLocked}; const mangle=${this.mangleCaption};
const menuReel = ${this.reelViaMenu && reel};
if ($('createMenu')) {
  $('createMenu').onclick=()=>{ $('menuReel').hidden=false; };
  $('menuReel').onclick=()=>{ location.href='/reels/create'; };
}
const refresh=()=>{ $('post').disabled = !($('tb').innerText.trim() || files.length); };
if ($('next')) {
  $('file').addEventListener('change', () => { $('next').disabled = !$('file').files.length; });
  $('next').onclick = () => {
    if(menuReel && $('composerTitle').innerText === 'Tạo thước phim'){
      $('composerTitle').innerText='Chỉnh sửa thước phim';
      $('dlg').removeAttribute('aria-label');
      return;
    }
    if(menuReel) $('composerTitle').innerText='Cài đặt thước phim';
    $('next').hidden = true; $('tb').hidden = false;
  };
}
$('open').onclick=()=>{ $('dlg').hidden=false; };
$('tb').addEventListener('input',refresh);
$('addm').onclick=()=>$('file').click();
$('file').onchange=(e)=>{ files=[...e.target.files]; $('thumbs').innerHTML=files.map((f,i)=> f.type.startsWith('video') ? (menuReel ? '<canvas></canvas><button>Tạm dừng video</button>' : '<div aria-label="Video"><video></video></div>') : (i >= 5 ? '' : '<div aria-label="Ảnh '+(i+1)+'"><img alt="" style="width:80px;height:80px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'+(i === 4 && files.length > 5 ? '<span>+'+(files.length - 4)+'</span>' : '')+'</div>')).join(''); refresh(); };
$('aud').onclick=()=>{ $('audp').hidden=false; };
document.querySelectorAll('[data-v]').forEach(r=>r.onclick=()=>{ pending=r.dataset.v; });
$('audok').onclick=()=>{ if(!locked){ audience=pending; if(!menuReel) $('aud').setAttribute('aria-label','Chỉnh sửa quyền riêng tư. Đối tượng: '+audience); $('aud').textContent=menuReel ? (${JSON.stringify(REEL_CHIP)})[audience] : audience; } $('audp').hidden=true; if(menuReel){ $('post').disabled=true; setTimeout(refresh, 750); } };
$('close').onclick=()=>{ if($('tb').innerText.trim()||files.length){ $('disc').hidden=false; } else { $('dlg').hidden=true; } };
$('discok').onclick=()=>{ $('disc').hidden=true; $('dlg').hidden=true; $('tb').innerText=''; files=[]; $('thumbs').innerHTML=''; };
$('post').onclick=async()=>{
  let caption=$('tb').innerText; if(mangle) caption=caption.slice(0,-1);
  const r=await (await fetch('/__post',{method:'POST',body:JSON.stringify({caption,media:files.length,video:files.some(f=>f.type.startsWith('video')),audience,reel:${reel}})})).json();
  if(r.close){ $('dlg').hidden=true; if(r.toast) $('toast').innerHTML=${JSON.stringify(reel ? '<a href="/reel/' : '<a href="/posts/')}+r.id+${JSON.stringify(reel ? '">Xem thước phim</a>' : '">Xem bài viết</a>')}; }
};
</script></body></html>`;
  }
}

/** Reel settings audience chip text as the real vi-VN UI renders it (label + description). */
const REEL_CHIP: Record<string, string> = {
  'Chỉ mình tôi': 'Chỉ mình tôi Chỉ mình tôi',
  'Bạn bè': 'Bạn bè Bạn bè trên Facebook',
  'Công khai': 'Công khai Bất kỳ ai ở trên hoặc ngoài Facebook',
};
const reelChip = (a: string) => REEL_CHIP[a] ?? a;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
