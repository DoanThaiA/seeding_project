import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

/**
 * Stand-in for a person's OWN Facebook profile page, as seen when logged in as that person.
 * Mirrors what the real page does that matters to the reader: posts render only after scrolling,
 * timestamp links have href="#" until hovered, long captions end with "Xem thêm", photos are links
 * to /photo, large albums show a "+N" tile, videos are <video>, and friends can post on the wall.
 */
export interface ProfilePost {
  id: string;
  author?: string; // default: the owner
  text: string;
  photos?: number;
  more?: number;
  video?: boolean;
  playable?: boolean;
  sharedReel?: 'attached' | 'shorts';
  comments?: boolean;
  structuredComments?: boolean;
  commentPagination?: 'complete' | 'blocked';
  archivedCommentThread?: boolean;
  commentDelayMs?: number;
  commentPermalinkId?: string;
  nestedReply?: boolean;
  lazyCommentPage?: boolean;
  emptyComments?: boolean;
  detailCaption?: string;
  messageRoleOnly?: boolean;
  quoteBackground?: boolean;
  gallery?: boolean;
  galleryWrapCount?: number;
  galleryPayload?: boolean;
  detailPhotoIds?: string[];
  playbackVideoId?: string;
  timeText?: string;
  missingPermalink?: boolean;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
export function png(seed: number): Buffer {
  const w = 4, h = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, seed % 256);
  row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class MockProfile {
  session: 'OK' | 'LOGGED_OUT' | 'CHECKPOINT' = 'OK';
  userId = '100094351016079';
  owner = 'Hoàng Thử Nghiệm';
  posts: ProfilePost[] = [];
  baseUrl = '';
  imageHits = 0;
  guestMode = false;
  latePostsStart?: number;
  profileArtwork?: { avatar: string; cover: string; avatarOwner?: string };
  archiveFixture = false;
  directoryAbout = false;
  profileNameOutsideHeading = false;
  profileHeaderDelay = 0;
  signedInAs?: string;
  timelineRequests: Array<{ path: string; cookie?: string }> = [];
  private server!: Server;

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const html = (b: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(b);
      };
      const m = url.pathname.match(/^\/img\/(\d+)\.png$/);
      if (m) {
        this.imageHits++;
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(png(Number(m[1])));
      }
      if (url.pathname === '/login/') return html('<form><input name="email"><input type="password" name="pass"></form>');
      if (url.pathname === '/checkpoint/') return html('<h1>Xác nhận danh tính của bạn</h1>');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      this.timelineRequests.push({ path: url.pathname, cookie: req.headers.cookie });
      if (this.session !== 'OK' || (this.signedInAs && req.headers.cookie !== 'fixture-session=ok')) {
        res.writeHead(302, { location: this.session === 'LOGGED_OUT' ? '/login/' : '/checkpoint/' });
        return res.end();
      }
      if (url.pathname === '/me') {
        res.writeHead(302, { location: `/profile.php?id=${this.signedInAs ?? this.userId}` });
        return res.end();
      }
      if (this.directoryAbout && url.pathname === '/profile.php' &&
        ['about', 'directory_personal_details'].includes(url.searchParams.get('sk') ?? '')) {
        return html(`<main><article>
          <h2>Giới thiệu</h2>
          <div><a role="tab" aria-selected="${url.searchParams.get('sk') === 'directory_personal_details'}" href="/profile.php?id=${this.userId}&amp;sk=directory_personal_details">Thông tin cá nhân</a></div>
          <div><section><h2>Giới tính</h2><p>Giá trị hiển thị</p><span>Giới tính</span>
            <button onclick="document.getElementById('about-extra').hidden=false;this.hidden=true">Xem thêm</button>
            <p id="about-extra" hidden>Chi tiết mở rộng</p></section>
            <section><h2>Nơi từng sống</h2><p>Không có địa điểm nào để hiển thị</p></section></div>
          </article><section><h2>Hồ sơ gợi ý</h2><p>Dữ liệu hồ sơ khác</p></section></main>`);
      }
      if (this.profileArtwork && url.pathname === '/profile.php') {
        const header = { id: this.userId, profilePhoto: { id: this.profileArtwork.avatar },
          cover_photo: { photo: { id: this.profileArtwork.cover } } };
        const data = `<script type="application/json">${JSON.stringify(header)}</script>`;
        return html(this.archiveFixture ? this.page(data) : `<h1>${esc(this.owner)}</h1>${data}`);
      }
      if (this.profileArtwork && url.pathname === '/photo/') {
        const id = url.searchParams.get('fbid');
        if (id === this.profileArtwork.avatar || id === this.profileArtwork.cover) {
          const owner = id === this.profileArtwork.avatar ? this.profileArtwork.avatarOwner ?? this.userId : this.userId;
          const image = { uri: `${this.baseUrl}/img/${id}.png`, width: 4, height: 4 };
          return html(`<script type="application/json">${JSON.stringify({ id, owner: { id: owner }, image })}</script>`);
        }
      }
      if (this.guestMode && ['/video.mp4', '/reel-fixture.mp4'].includes(url.pathname)) {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        return res.end(Buffer.from('test video media ' + url.pathname));
      }
      if (this.guestMode && url.pathname.startsWith('/reel/')) {
        const id = url.pathname.split('/').filter(Boolean).at(-1);
        const p = this.posts.find(post => post.playbackVideoId === id);
        if (p) {
          if (p.comments) {
            const comment = (story: string, id: string) => encodeURIComponent(Buffer.from(`comment:${story}_${id}`).toString('base64'));
            const link = '/profile.php?comment_id=' + comment('8900', '105');
            if (p.archivedCommentThread) {
              const card = (id: string, parent?: string) => `<article><a href="/profile.php?comment_id=${comment('8900', parent ?? id)}${parent
                ? '&amp;reply_comment_id=' + comment('8900', id) : ''}">Vừa xong</a><div data-comment-text>Bình luận ${id}</div></article>`;
              const video = { id, creation_story: { message: { text: p.text } } };
              return html(`<main>
                <section style="height:850px"><video style="display:block;width:480px;height:270px"></video>
                  <button aria-label="Bình luận, 4 bình luận" onclick="document.querySelector('#comment-rail').hidden=false">Bình luận</button></section>
                <section><video style="display:block;width:480px;height:270px"></video>
                  <button aria-label="Bình luận, 3,8K bình luận" onclick="document.querySelector('#suggestion').hidden=false">Bình luận</button></section>
              </main>
              <aside id="comment-rail" hidden style="position:fixed;right:0;top:0">
                <section>${card('105')}<button id="reply" onclick="advanceReply(this)">Xem 1 phản hồi</button></section>
                <button id="more" onclick="advancePage(this)">Xem thêm bình luận</button>
              </aside>
              <aside id="suggestion" hidden><article><a href="/profile.php?comment_id=${comment('9990','999')}">Khác bài</a></article></aside>
              <script>
                function advanceReply(button){button.insertAdjacentHTML('beforebegin',${JSON.stringify(card('106', '105'))});button.hidden=true}
                let next=0;
                function advancePage(button){button.insertAdjacentHTML('beforebegin',${JSON.stringify([card('107'),card('108')])}[next++]);if(next===2)button.hidden=true}
              </script>
              <script type="application/json">${JSON.stringify({ result: { data: { video } } })}</script>`);
            }
            return html(`<main data-comment-count="2">
              <button id="open-thread" hidden aria-label="Bình luận, 2 bình luận" onclick="document.querySelector('#thread').hidden=false">Bình luận</button>
              <article data-commentid="999"><a href="/profile.php?comment_id=${comment('9990', '999')}">Khác bài</a></article>
              </main>
              <section id="thread" hidden><button>Tất cả bình luận</button>
                <article data-commentid="105"><a href="${link}">1 giờ</a><div data-comment-text>Bình luận Reel</div>
                  <article data-commentid="106"><a href="${link}&amp;reply_comment_id=${comment('8900', '106')}">Vừa xong</a><div data-comment-text>Phản hồi Reel</div></article>
                </article>
              </section>
              <script>setTimeout(()=>document.querySelector('#open-thread').hidden=false, 900)</script>
              <meta property="og:video" content="${this.baseUrl}/reel-fixture.mp4">`);
          }
          const creation_story = { message: { text: p.text }, short_form_video_context: { playback_video: {
            id, videoDeliveryLegacyFields: { browser_native_hd_url: this.baseUrl + '/expired.mp4', browser_native_sd_url: this.baseUrl + '/video.mp4' },
          } } };
          return html(`<script type="application/json">${JSON.stringify({ result: { data: { video: { id, creation_story } } } })}</script>`);
        }
      }
      if (url.pathname === '/expired.mp4') { res.writeHead(403); return res.end(); }
      if (this.guestMode && url.pathname === '/photo/' && url.searchParams.get('set')?.startsWith('pcb.')) {
        const id = url.searchParams.get('set')!.slice(4);
        const p = this.posts.find(post => post.id === id);
        const index = Number(url.searchParams.get('fbid')?.slice(id.length));
        const total = p?.galleryWrapCount ?? (p?.photos ?? 0) + (p?.more ?? 0);
        if (p?.gallery && index >= 0 && index < total) {
          const next = index + 1 < total ? index + 1 : p.galleryWrapCount ? 0 : null;
          const image = '/img/' + (this.posts.indexOf(p) * 10 + 10 + index) + '.png';
          if (p.galleryPayload) {
            const response = { result: { data: { mediaset: { id: Buffer.from('mediaset:pcb.' + id).toString('base64') },
              currMedia: { id: id + index, image: { uri: this.baseUrl + image } } } } };
            const nav = { result: { data: { __isMediaSet: 'MediaSet', nextMediaAfterNodeId: next === null ? null : { __typename: 'Photo', id: id + next } } } };
            return html(`<script type="application/json">${JSON.stringify([response, nav])}</script>`);
          }
          return html(`<main><img data-source-photo src="${image}">
            ${next === null ? '' : `<a aria-label="Ảnh tiếp theo" href="/photo/?fbid=${id}${next}&set=pcb.${id}">Tiếp</a>`}</main>`);
        }
      }
      if (this.guestMode && url.pathname.includes('/posts/')) {
        const p = this.posts.find(post => url.pathname.endsWith('/' + post.id));
        if (p?.commentPagination) {
          const archived = p.archivedCommentThread;
          const encoded = (id: string) => encodeURIComponent(Buffer.from('comment:123456_' + id).toString('base64'));
          const rotatedPath = '/profile/posts/pfbidARCHIVEDROTATED';
          const card = (id: string, parent?: string, children = '') => {
            const link = (archived ? rotatedPath : url.pathname) + '?comment_id=' + (parent
              ? (archived ? encoded(parent) : '201') + '&amp;reply_comment_id=' + (archived ? encoded(id) : id)
              : archived ? encoded(id) : id);
            return `<article id="comment-${id}" ${parent ? `data-parent-comment-id="${parent}"` : ''}>
              <a href="${link}">Vừa xong</a><div data-comment-text>Bình luận ${id}</div>${children}</article>`;
          };
          const nested = '<button id="nested-more" onclick="nextNested(this)">Xem 1 phản hồi mới hơn</button>';
          const branches = '<section id="replies"><button id="reply-more" onclick="nextReply(this)">Xem thêm 2 lượt trả lời khác</button></section>';
          const blocked = p.commentPagination === 'blocked'
            ? '<button onclick="return false">Xem thêm bình luận khác</button>' : '';
          const node = (id: string, path: string, photo: string) => ({ result: { data: { node_v2: {
            id: Buffer.from(`S:_I10099:${id}:${id}`).toString('base64'), permalink_url: this.baseUrl + path, comet_sections: {
              content: { story: { message: { text: p.text }, attachments: [{ media: { __typename: 'Photo', id: photo } }] } },
            },
          } } } });
          const hydration = archived ? `<script type="application/json">${JSON.stringify([
            node('123456', rotatedPath, '234567'), node('999999', '/user/posts/other', '345678'),
          ])}</script>` : '';
          return html(`<main data-comment-count="1">
            <article ${archived ? 'role="dialog"' : ''}>${archived ? '' : `
              <button id="sort" onclick="document.getElementById('all').hidden=false">Phù hợp nhất</button>
              <button role="menuitemradio" id="all" hidden onclick="this.hidden=true;document.getElementById('sort').textContent='Tất cả bình luận'">Tất cả bình luận</button>`}
              <section id="roots">${card('201', undefined, branches)}</section>
              ${blocked}
              <a href="#" id="root-more" onclick="nextRoot(this);return false">${archived ? 'Xem các bình luận trước' : 'Xem thêm bình luận trước đó'}</a>
              <p role="status" id="end" hidden>Không còn bình luận</p>
            </article>
            <article><a href="/user/posts/other?comment_id=999">Bài khác</a><button onclick="document.getElementById('end').textContent='Không hợp lệ'">Xem thêm bình luận</button></article>
            ${hydration}
            <script>
              const insert=(control, content, onDone)=>{const section=control.parentElement;section.setAttribute('aria-busy','true');
                setTimeout(()=>{control.insertAdjacentHTML('beforebegin',content);section.removeAttribute('aria-busy');onDone?.();},1250);};
              let rootPage=0;
              function nextRoot(control){
                const pages=${JSON.stringify([card('202'), card('203'), card('207')])};
                insert(control, pages[rootPage++],()=>{
                  if(rootPage===pages.length){
                    control.hidden=true;document.querySelector('main').dataset.commentCount='${archived ? 4 : 7}';
                    document.getElementById('end').hidden=false;document.getElementById('end').textContent='Không còn bình luận';
                  }
                });
              }
              let replyPage=0;
              function nextReply(control){
                const pages=${JSON.stringify([card('204', '201', nested), card('205', '201')])};
                insert(control, pages[replyPage++],()=>{if(replyPage===pages.length)control.hidden=true;});
              }
              function nextNested(control){insert(control,${JSON.stringify(card('206','204'))},()=>control.hidden=true);}
            </script></main>`);
        }
        if (p?.detailPhotoIds?.length) {
          const ids = p.detailPhotoIds;
          const set = 'pcb.112233';
          const media = (id: string) => ({ id, __typename: 'Photo' });
          const attachment = ids.length === 1
            ? { target: media(ids[0]), media: media(ids[0]) }
            : { target: { id: Buffer.from('mediaset:' + set).toString('base64') }, all_subattachments: { nodes: ids.map(id => ({ media: media(id) })) } };
          const story = { message: { text: p.text }, attachments: [attachment] };
          const node_v2 = { id: p.id, permalink_url: this.baseUrl + url.pathname, comet_sections: { content: { story } } };
          return html('<main>' + ['999', ...ids].map(id => `<a href="/photo/?fbid=${id}${ids.includes(id) && ids.length > 1 ? '&amp;set=' + set : ''}"><img src="/img/${id}.png"></a>`).join('') +
            `<script type="application/json">${JSON.stringify({ result: { data: { node_v2 } } })}</script></main>`);
        }
        if (p?.emptyComments) {
          const thread = { comments: { total_count: 0, edges: [], page_info: { has_next_page: false } } };
          const story = { feedback_context: { feedback_target_with_context: {
            comment_list_renderer: { feedback: { comment_rendering_instance_for_feed_location: thread } },
          } } };
          const node = { id: p.id, comet_sections: { content: { story: { actors: [{ name: this.owner }] } }, feedback: { story } } };
          return html(`${p.playable ? `<meta property="og:video" content="${this.baseUrl}/video.mp4">` : ''}
            <main><button aria-label="Bình luận về bài viết của ${esc(this.owner)}">Bình luận</button>
            <div aria-hidden="true"><button aria-label="Bình luận về bài viết khác, 3 bình luận">Bình luận</button></div>
            <script type="application/json">${JSON.stringify({ result: { data: { node_v2: node } } })}</script></main>`);
        }
        if (p?.comments) {
          if (p.structuredComments) {
            const oldPath = '/profile/posts/pfbidROTATED';
            const parent = { __typename: 'Comment', id: 'parent', legacy_fbid: '101', body: { text: 'Bình luận chính' }, author: { name: 'Khách A' } };
            const encoded = (id: string) => encodeURIComponent(Buffer.from('comment:123_' + id).toString('base64'));
            const thread = { comments: { count: 1, edges: [{ node: parent }] } };
            const expected = p.lazyCommentPage ? undefined : p.nestedReply ? 3 : 2;
            const story = { feedback_context: { feedback_target_with_context: { total_comment_count: expected,
              comment_list_renderer: { feedback: { comment_rendering_instance_for_feed_location: thread } } } } };
            const node = { id: p.id, permalink_url: this.baseUrl + oldPath, comet_sections: {
              content: { story: { actors: [{ name: this.owner }] } }, feedback: { story: { story_ufi_container: { story } } },
            } };
            const data = { recommendation: { __typename: 'Comment', legacy_fbid: '999', body: { text: 'Khác bài' } }, __bbox: { result: { data: { node_v2: node } } } };
            const lateComment = `<article data-commentid="104"><a href="${url.pathname}?comment_id=104">Vừa xong</a><div data-comment-text>Bình luận tải thêm</div></article>`;
            const content = `<main ${expected === undefined ? '' : `data-comment-count="${expected}"`}><button>Tất cả bình luận</button>
              ${p.lazyCommentPage ? '<section id="thread-scroll" style="height:450px;overflow-y:auto">' : ''}
              <article aria-label="Bình luận dưới bài"><a href="/profile?comment_id=${encoded('101')}">Khách A</a>
                <a href="${oldPath}?comment_id=101">1 giờ</a><div data-comment-text>Bình luận chính</div>
                <button onclick="document.getElementById('reply').hidden=false;this.hidden=true">Xem 1 câu trả lời</button>
                <article hidden id="reply" aria-label="Phản hồi bình luận">
                  <a href="/profile?comment_id=${encoded('102')}">Khách B</a>
                  <a href="/profile/posts/pfbidROTATEDAGAIN?comment_id=101&amp;reply_comment_id=102">30 phút</a>
                  <div data-comment-text>Phản hồi https://s.shopee.vn/an_redir?affiliate_id=1</div>
                  ${p.nestedReply ? `<button onclick="document.getElementById('nested').hidden=false;this.hidden=true">View 1 more reply</button>
                    <article hidden id="nested" aria-label="Phản hồi bình luận" data-parent-comment-id="102">
                      <a href="${url.pathname}?comment_id=101&amp;reply_comment_id=103">Vừa xong</a>
                      <div data-comment-text>Phản hồi cấp hai</div>
                    </article>` : ''}
                </article>
              </article>
              <article aria-label="Bình luận dưới bài"><a href="/user/posts/other?comment_id=999">1 giờ</a><div data-comment-text>Khác bài</div></article>
              ${p.lazyCommentPage ? `<div id="spacer" style="height:900px"></div></section>
                <script>const box=document.querySelector('#thread-scroll');box.onscroll=()=>{
                  if (!document.querySelector('[data-commentid="104"]') && box.scrollTop>100) {
                    document.querySelector('#spacer').insertAdjacentHTML('beforebegin',${JSON.stringify(lateComment)});
                    document.querySelector('main').dataset.commentCount='4';
                  }
                }</script>` : ''}
              <script type="application/json">${JSON.stringify(data)}</script></main>`;
            return html(p.commentDelayMs
              ? `<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(content).replace(/</g, '\\u003c')}), ${p.commentDelayMs})</script>`
              : content);
          }
          const link = p.commentPermalinkId
            ? url.pathname.replace(/[^/]+$/, p.commentPermalinkId) + '?comment_id=101'
            : url.pathname + '?comment_id=101';
          return html(`<main data-comment-count="2">
            <button>Tất cả bình luận</button>
            <article data-commentid="101">
              <span data-comment-author>Khách A</span><a href="${link}">1 giờ</a><div data-comment-text>Bình luận chính</div>
              <article data-commentid="102" data-parent-comment-id="101">
                <span data-comment-author>Khách B</span><a href="${link}&amp;reply_comment_id=102">30 phút</a>
                <div data-comment-text>Phản hồi https://s.shopee.vn/an_redir?affiliate_id=1</div>
              </article>
            </article>
            <article data-commentid="999"><a href="/user/posts/other?comment_id=999">1 giờ</a><div data-comment-text>Khác bài</div></article>
          </main>`);
        }
        if (p?.detailCaption) {
          const story = { message: { text: p.detailCaption } };
          const node = { id: p.id, permalink_url: this.baseUrl + '/profile/posts/pfbidROTATED', comet_sections: { content: { story } } };
          return html(`<meta property="og:video" content="${this.baseUrl}/video.mp4"><script type="application/json">${JSON.stringify({ __bbox: { result: { data: { node_v2: node } } } })}</script>`);
        }
        if (p?.sharedReel) {
          const video = { __typename: 'Video', id: '1234567', videoDeliveryResponseFragment: {
            videoDeliveryResponseResult: { progressive_urls: [{ progressive_url: this.baseUrl + '/video.mp4' }] },
          } };
          const reel = { url: 'https://www.facebook.com/reel/' + video.id + '/', attachments: [{ media: video }] };
          const story = p.sharedReel === 'attached' ? { attached_story: reel }
            : { attachments: [{ styles: { attachment: { style_infos: [{ fb_shorts_story: reel }] } } }] };
          const node = { id: p.id, comet_sections: { content: { story } } };
          const data = { recommendation: { ...video, id: '654321', playable_url: this.baseUrl + '/wrong.mp4' },
            __bbox: { result: { data: { node_v2: node } } } };
          return html(`<script type="application/json">${JSON.stringify(data)}</script>`);
        }
        return html(p?.playable ? `<meta property="og:video" content="${this.baseUrl}/video.mp4">` : '<main>Video</main>');
      }
      return html(this.page());
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private post(p: ProfilePost, n: number): string {
    const long = p.text.length > 80;
    const shown = long ? `${esc(p.text.slice(0, 60))}… <div role="button" onclick="const m=this.parentElement;m.textContent=m.dataset.full">Xem thêm</div>` : esc(p.text);
    const photos = Array.from({ length: p.photos ?? 0 }, (_, i) => {
      const plus = p.more && i === (p.photos ?? 0) - 1 ? `<div style="position:absolute;inset:0"><span>+${p.more}</span></div>` : '';
      return `<a href="/photo/?fbid=${p.id}${i}${p.gallery ? '&set=pcb.' + p.id : ''}" style="display:inline-block;position:relative"><img alt="" style="width:200px;height:200px" src="${this.baseUrl}/img/${n * 10 + i}.png">${plus}</a>`;
    }).join('');
    const video = p.video ? '<video style="width:400px;height:220px"></video>' : '';
    return `<div class="post" ${this.guestMode && !this.signedInAs ? 'role="article"' : ''} style="margin:20px 0">
      <h3><a href="${this.guestMode && p.author ? '/other.profile' : '/profile.php?id=' + this.userId}">${esc(p.author ?? this.owner)}</a></h3>
      <span><a href="#" aria-describedby="t${n}" data-real="${p.playbackVideoId ? '/reel/' + p.playbackVideoId : '/' + this.userId + '/posts/' + p.id}" ${p.missingPermalink ? '' : 'onmouseover="this.href=this.dataset.real"'}>${esc(p.timeText ?? 'Vừa xong')}</a></span>
      <div ${p.messageRoleOnly ? 'data-ad-rendering-role="story_message"' : 'data-ad-preview="message"'} data-full="${esc(p.text)}">
        ${p.quoteBackground ? `<div style="width:400px;height:220px;background-image:url('/img/${n * 10}.png');background-size:cover">${shown}</div>` : shown}
      </div>
      ${photos}${video}
      <div><span>Thích</span> <span>Bình luận</span></div>
    </div>`;
  }

  private page(extra = ''): string {
    const cards = this.posts.map((p, i) => this.post(p, i + 1));
    const posts = cards.slice(0, this.latePostsStart ?? cards.length).join('') || (this.guestMode ? '<p>Chưa có bài viết nào</p>' : '');
    const late = (this.latePostsStart === undefined ? '' : cards.slice(this.latePostsStart).join(''))
      + (this.archiveFixture ? '<p>Không còn bài viết</p>' : '');
    const profile = { __isProfile: 'User', __isRenderedProfile: 'User', id: this.userId, url: this.baseUrl + '/profile.php?id=' + this.userId, name: this.owner };
    return `<!doctype html><html lang="vi"><body>${extra}
      ${this.profileNameOutsideHeading ? `<svg hidden aria-label="${esc(this.owner)}" width="24" height="24"><rect width="24" height="24" /></svg>
        <script>setTimeout(() => document.querySelector('svg').removeAttribute('hidden'), ${this.profileHeaderDelay})</script>
        <script type="application/json">${JSON.stringify(profile).replace(/</g, '\\u003c')}</script>` : `<h1>${esc(this.owner)}</h1>`}
      ${this.guestMode && !this.signedInAs ? '<form><input type="password" name="pass"></form>' : ''}
      <div style="height:1500px">Giới thiệu · Bạn bè · Ảnh</div>
      <div id="posts"></div><div style="height:2500px"></div>
      <script>const html=${JSON.stringify(posts)};let done=false;const f=()=>{if(!done&&window.scrollY>300){done=true;document.getElementById('posts').innerHTML=html;}};addEventListener('scroll',f);f();</script>
      ${late ? `<script>const more=${JSON.stringify(late)}; let loaded=false; addEventListener('scroll',()=>{
        if(!loaded && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
          loaded=true;document.getElementById('posts').insertAdjacentHTML('beforeend', more);
        }
      })</script>` : ''}
    </body></html>`;
  }
}
