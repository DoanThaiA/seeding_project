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
  posts: MockPost[] = [];
  comments: Array<{ postId: string; id: string; parentId?: string; text: string }> = [];
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
    if (url.pathname === '/notifications') {
      return send(200, `<!doctype html><html><body>${this.posts.filter(p => p.reel).map(p =>
        `<a href="/reel/${p.id}">Chưa đọc Bạn có thể xem thước phim rồi. Hãy chia sẻ với bạn bè nhé. ${this.rel(p)}</a>`).join('')}</body></html>`);
    }
    if (url.pathname === '/') return send(200, this.home());
    if (url.pathname === '/reels/create') return send(200, this.home(true));
    const post = this.posts.find(p => url.pathname === (p.reel ? '/reel/' : '/posts/') + p.id);
    if (post && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { text, parentId } = JSON.parse(raw);
      const comment = { postId: post.id, id: 'c' + (this.comments.length + 1), text, parentId };
      this.comments.push(comment);
      return send(200, JSON.stringify(comment), 'application/json');
    }
    if (post) return send(200, this.postPage(post));
    return send(200, this.timeline()); // /profile.php?id=… and /<vanity>
  }

  private postPage(post: MockPost) {
    const items = this.comments.filter(c => c.postId === post.id);
    return `<main><p>${esc(post.caption)}</p>${post.video ? '<video style="width:120px;height:160px"></video>' : ''}
      <section id="comments"></section><textarea aria-label="Viết bình luận"></textarea>
      <script>
        const comments = document.querySelector('#comments');
        const editor = document.querySelector('textarea');
        let parentId;
        function add(comment) {
          const article = document.createElement('article');
          const text = document.createElement('div');
          text.textContent = comment.text;
          const link = document.createElement('a');
          link.href = ${this.pfbidCommentLinks ? `'/tester/posts/pfbid0Zz${post.id}'` : 'location.pathname'} + '?comment_id=' + (comment.parentId || comment.id) + (comment.parentId ? '&reply_comment_id=' + comment.id : '')${this.pfbidCommentLinks ? " + '&__cft__[0]=z'" : ''};
          link.textContent = 'Vừa xong';
          const reply = document.createElement('button');
          reply.textContent = 'Phản hồi';
          reply.onclick = () => { parentId = comment.id; editor.setAttribute('aria-label', 'Viết phản hồi'); editor.focus(); };
          article.append(text, link, reply);
          comments.append(article);
        }
        ${JSON.stringify(items).replace(/</g, '\\u003c')}.forEach(add);
        editor.onkeydown = async e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const response = await fetch(location.pathname, { method: 'POST', body: JSON.stringify({ text: editor.value, parentId }) });
          add(await response.json());
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
        const media = p.video ? '<video src="data:video/mp4;base64,AAAA"></video>' : Array.from({ length: p.media }, (_, i) => `<a href="/photo?fbid=${p.id}_${i}"><img alt="" style="width:80px;height:80px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a>`).join('');
        return `<div data-post="1"><h3>Tester</h3>${p.hiddenTime ? '<a href="#"></a>' : p.lazyHref ? `<a href="?__cft__[0]=x" onmouseover="this.setAttribute('href','/posts/${p.id}?__cft__[0]=x')">dSnoprteos</a>` : `<a href="/${p.reel ? 'reel' : 'posts'}/${p.id}">${this.rel(p)}</a>`}<div>${esc(p.caption)}</div>${p.processing ? '<div>Video đang được xử lý</div>' : ''}${media}</div>`;
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
  ? '<button id="createMenu">Menu trên Facebook</button><button id="menuReel" hidden>Thước phim</button>'
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
