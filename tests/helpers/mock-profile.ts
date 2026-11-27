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
  commentDelayMs?: number;
  commentPermalinkId?: string;
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
      if (this.profileArtwork && url.pathname === '/profile.php') {
        const header = { id: this.userId, profilePhoto: { id: this.profileArtwork.avatar },
          cover_photo: { photo: { id: this.profileArtwork.cover } } };
        return html(`<h1>${esc(this.owner)}</h1><script type="application/json">${JSON.stringify(header)}</script>`);
      }
      if (this.profileArtwork && url.pathname === '/photo/') {
        const id = url.searchParams.get('fbid');
        if (id === this.profileArtwork.avatar || id === this.profileArtwork.cover) {
          const owner = id === this.profileArtwork.avatar ? this.profileArtwork.avatarOwner ?? this.userId : this.userId;
          const image = { uri: `${this.baseUrl}/img/${id}.png`, width: 4, height: 4 };
          return html(`<script type="application/json">${JSON.stringify({ id, owner: { id: owner }, image })}</script>`);
        }
      }
      if (this.guestMode && url.pathname === '/video.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        return res.end(Buffer.from('test video media'));
      }
      if (this.guestMode && url.pathname.startsWith('/reel/')) {
        const id = url.pathname.split('/').filter(Boolean).at(-1);
        const p = this.posts.find(post => post.playbackVideoId === id);
        if (p) {
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
          return html(`<main><button aria-label="Bình luận về bài viết của ${esc(this.owner)}">Bình luận</button>
            <div aria-hidden="true"><button aria-label="Bình luận về bài viết khác, 3 bình luận">Bình luận</button></div>
            <script type="application/json">${JSON.stringify({ result: { data: { node_v2: node } } })}</script></main>`);
        }
        if (p?.comments) {
          if (p.structuredComments) {
            const oldPath = '/profile/posts/pfbidROTATED';
            const parent = { __typename: 'Comment', id: 'parent', legacy_fbid: '101', body: { text: 'Bình luận chính' }, author: { name: 'Khách A' } };
            const encoded = (id: string) => encodeURIComponent(Buffer.from('comment:123_' + id).toString('base64'));
            const thread = { comments: { count: 1, edges: [{ node: parent }] } };
            const story = { feedback_context: { feedback_target_with_context: { total_comment_count: 2,
              comment_list_renderer: { feedback: { comment_rendering_instance_for_feed_location: thread } } } } };
            const node = { id: p.id, permalink_url: this.baseUrl + oldPath, comet_sections: {
              content: { story: { actors: [{ name: this.owner }] } }, feedback: { story: { story_ufi_container: { story } } },
            } };
            const data = { recommendation: { __typename: 'Comment', legacy_fbid: '999', body: { text: 'Khác bài' } }, __bbox: { result: { data: { node_v2: node } } } };
            const content = `<main data-comment-count="2"><button>Tất cả bình luận</button>
              <article aria-label="Bình luận dưới bài"><a href="/profile?comment_id=${encoded('101')}">Khách A</a>
                <a href="${oldPath}?comment_id=101">1 giờ</a><div data-comment-text>Bình luận chính</div>
                <button onclick="document.getElementById('reply').hidden=false;this.hidden=true">Xem 1 câu trả lời</button>
                <article hidden id="reply" aria-label="Phản hồi bình luận">
                  <a href="/profile?comment_id=${encoded('102')}">Khách B</a>
                  <a href="/profile/posts/pfbidROTATEDAGAIN?comment_id=101&amp;reply_comment_id=102">30 phút</a>
                  <div data-comment-text>Phản hồi https://s.shopee.vn/an_redir?affiliate_id=1</div>
                </article>
              </article>
              <article aria-label="Bình luận dưới bài"><a href="/user/posts/other?comment_id=999">1 giờ</a><div data-comment-text>Khác bài</div></article>
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

  private page(): string {
    const cards = this.posts.map((p, i) => this.post(p, i + 1));
    const posts = cards.slice(0, this.latePostsStart ?? cards.length).join('') || (this.guestMode ? '<p>Chưa có bài viết nào</p>' : '');
    const late = this.latePostsStart === undefined ? '' : cards.slice(this.latePostsStart).join('');
    return `<!doctype html><html lang="vi"><body>
      <h1>${esc(this.owner)}</h1>
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
