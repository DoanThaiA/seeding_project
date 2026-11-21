import { describe, expect, it } from 'vitest';
import { contentKey, contentText, isSamePost, rebaseMediaRef, stableMediaKey, type PostFacts } from './dedup';

const at = (iso: string) => new Date(iso);
const post = (over: Partial<PostFacts>): PostFacts => ({
  text: '', truncated: false, incomplete: false, contentType: 'TEXT', mediaRefs: [], ...over,
});

describe('contentText / contentKey', () => {
  it('ignores links, invisible characters, case, spacing and a trailing "Xem thêm"', () => {
    expect(contentText('Anh Jesen  mới quit​ NVIDIA\n\nhttp://leadscan.net/')).toBe('anh jesen mới quit nvidia');
    expect(contentText('Ưu đãi GIẢM 30%… Xem thêm')).toBe('ưu đãi giảm 30%');
  });

  it('keys equal content equally, whatever the media order', () => {
    const a = contentKey({ text: 'Khai trương', checksums: ['b', 'a'] });
    expect(a).toBe(contentKey({ text: ' khai   TRƯƠNG ', checksums: ['a', 'b'] }));
    expect(a).not.toBe(contentKey({ text: 'Khai trương', checksums: ['a', 'c'] }));
    expect(a).not.toBe(contentKey({ text: 'Khai trương', checksums: ['a'] }));
  });

  it('has nothing to compare for an empty post', () => {
    expect(contentKey({ text: '  https://example.org  ', checksums: [] })).toBe('');
    expect(contentKey({ text: '', checksums: ['a'] })).not.toBe('');
  });
});

describe('media refs', () => {
  it('extracts the platform photo/video id and ignores the post id', () => {
    expect(stableMediaKey('fb-public:pfbid0AAA:image:10233144645948624')).toBe('image:10233144645948624');
    expect(stableMediaKey('fb-public:pfbid0AAA:video:/v/t42/1.mp4')).toBe('video:/v/t42/1.mp4');
    expect(stableMediaKey('fbweb-photo:x:0')).toBeNull();
    expect(stableMediaKey('manual/abc/0.png')).toBeNull();
  });

  it('rebases a ref read under an alias id', () => {
    expect(rebaseMediaRef('fb-public:pfbidNEW:image:42', 'pfbidNEW', 'pfbidOLD')).toBe('fb-public:pfbidOLD:image:42');
    expect(rebaseMediaRef('fb-public:other:image:42', 'pfbidNEW', 'pfbidOLD')).toBe('fb-public:other:image:42');
    expect(rebaseMediaRef('manual/abc/0.png', 'pfbidNEW', 'pfbidOLD')).toBe('manual/abc/0.png');
  });
});

describe('isSamePost', () => {
  it('matches a rotated pfbid by the shared photo id (C89 case: one read had no time)', () => {
    const first = post({ text: 'C89 xin mời các doanh nhân', contentType: 'SINGLE_PHOTO', mediaRefs: ['fb-public:pfbid035R:image:777'] });
    const again = post({ ...first, mediaRefs: ['fb-public:pfbid021Q:image:777'], postedAt: at('2026-11-08T05:07:00Z'), postedAtExact: true });
    expect(isSamePost(first, again)).toBe(true);
  });

  it('keeps posts with different photos apart even with the same caption', () => {
    const a = post({ text: 'Hàng mới về', contentType: 'SINGLE_PHOTO', mediaRefs: ['fb-public:p1:image:1'] });
    expect(isSamePost(a, { ...a, mediaRefs: ['fb-public:p2:image:2'] })).toBe(false);
  });

  it('matches a text post whose link preview was not read the second time (Anh Jesen case)', () => {
    const when = { postedAt: at('2026-11-13T01:50:00Z'), postedAtExact: true };
    const a = post({ text: 'Anh Jesen mới quit NVIDIA rồi\n\nhttp://leadscan.net/', ...when });
    const b = post({ text: 'Anh Jesen mới quit NVIDIA rồi', ...when });
    expect(isSamePost(a, b)).toBe(true);
  });

  it('matches a cut caption to the full one, but not a short or diverging prefix', () => {
    const full = post({ text: 'Khai trương chi nhánh mới ngày 5/12, giảm 20% cho mọi sản phẩm' });
    expect(isSamePost(post({ text: 'Khai trương chi nhánh mới ngày 5/12, giảm…', truncated: true, incomplete: true }), full)).toBe(true);
    expect(isSamePost(post({ text: 'Khai trương…', truncated: true, incomplete: true }), full)).toBe(false);
    expect(isSamePost(post({ text: 'Khai trương chi nhánh mới ngày 6/12, giảm…', truncated: true, incomplete: true }), full)).toBe(false);
  });

  it('treats the same caption on another day as another post', () => {
    const a = post({ text: 'Chúc mọi người ngày mới tốt lành', postedAt: at('2026-11-10T00:00:00Z'), postedAtExact: true });
    expect(isSamePost(a, { ...a, postedAt: at('2026-11-10T00:02:00Z') })).toBe(true);
    expect(isSamePost(a, { ...a, postedAt: at('2026-11-12T00:00:00Z') })).toBe(false);
    expect(isSamePost(a, { ...a, postedAt: at('2026-11-10T00:10:00Z') })).toBe(false);
    expect(isSamePost(a, { ...a, postedAt: at('2026-11-10T20:00:00Z'), postedAtExact: false })).toBe(true);
  });

  it('needs a caption or a media id, and a format that does not contradict', () => {
    expect(isSamePost(post({ contentType: 'VIDEO' }), post({ contentType: 'VIDEO' }))).toBe(false);
    const text = post({ text: 'Video giới thiệu cửa hàng' });
    expect(isSamePost(text, { ...text, contentType: 'VIDEO', mediaRefs: ['x'] })).toBe(false);
    expect(isSamePost({ ...text, incomplete: true }, { ...text, contentType: 'VIDEO', mediaRefs: ['x'] })).toBe(true);
  });
});
