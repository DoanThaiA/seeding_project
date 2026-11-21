'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

const MAX_IMAGES = 10;
const MAX_BYTES = 120 * 1024 * 1024;
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];

interface Picked {
  id: string;
  file: File;
  url: string; // object URL for the preview
  video: boolean;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function ImportForm({ sources }: { sources: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [text, setText] = useState('');
  const [albumTitle, setAlbumTitle] = useState('');
  const [origin, setOrigin] = useState('');
  const [rights, setRights] = useState(false);
  const [items, setItems] = useState<Picked[]>([]);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Free preview URLs when items go away / on unmount.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.url)), []);

  const hasVideo = items.some((i) => i.video);

  /** Each pick ADDS to the list (the browser's file box would otherwise replace the previous pick). */
  const addFiles = (list: FileList | null) => {
    setPickErr(null);
    if (!list || list.length === 0) return;
    const next = [...items];
    const problems: string[] = [];
    for (const file of Array.from(list)) {
      const video = file.type.startsWith('video/');
      if (!ACCEPT.includes(file.type)) {
        problems.push(`“${file.name}” không phải JPG, PNG, WebP, GIF, MP4 hoặc MOV`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        problems.push(`“${file.name}” lớn hơn 120 MB`);
        continue;
      }
      if (next.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) continue; // same file twice
      if (video && next.length > 0) {
        problems.push('Video phải đăng riêng: một bài chỉ có 1 video, không kèm ảnh');
        continue;
      }
      if (!video && next.some((i) => i.video)) {
        problems.push('Bài đã có video: không thêm ảnh được');
        continue;
      }
      if (!video && next.length >= MAX_IMAGES) {
        problems.push(`Tối đa ${MAX_IMAGES} ảnh mỗi bài`);
        break;
      }
      next.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, url: URL.createObjectURL(file), video });
    }
    setItems(next);
    if (problems.length) setPickErr([...new Set(problems)].join('. '));
    if (fileRef.current) fileRef.current.value = ''; // allow picking the same file again later
  };

  const remove = (id: string) =>
    setItems((cur) => {
      const it = cur.find((i) => i.id === id);
      if (it) URL.revokeObjectURL(it.url);
      return cur.filter((i) => i.id !== id);
    });

  const move = (idx: number, dir: -1 | 1) =>
    setItems((cur) => {
      const j = idx + dir;
      if (j < 0 || j >= cur.length) return cur;
      const copy = [...cur];
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });

  const clearAll = () => {
    items.forEach((i) => URL.revokeObjectURL(i.url));
    setItems([]);
    setPickErr(null);
  };

  const submit = () => {
    setMsg(null);
    start(async () => {
      const fd = new FormData();
      fd.set('text', text);
      if (albumTitle.trim()) fd.set('albumTitle', albumTitle);
      fd.set('origin', origin);
      fd.set('rightsConfirmed', String(rights));
      for (const it of items) fd.append('media', it.file); // order = order shown
      try {
        const res = await fetch(`/bff/sources/${sourceId}/manual-posts`, { method: 'POST', headers: { 'x-requested-with': 'seedingsys' }, body: fd });
        if (res.status === 401) return void (window.location.href = '/login?expired=1');
        const data = (await res.json().catch(() => ({}))) as { message?: string | string[]; contentType?: string; files?: number };
        if (!res.ok) {
          const m = data.message;
          return setMsg({ kind: 'err', text: Array.isArray(m) ? m.join('; ') : (m ?? `Lỗi ${res.status}`) });
        }
        const kind: Record<string, string> = { TEXT: 'bài chữ', SINGLE_PHOTO: 'bài 1 ảnh', MULTI_PHOTO: `bài ${data.files} ảnh`, VIDEO: 'bài video' };
        setMsg({ kind: 'ok', text: `Đã nhập ${kind[data.contentType ?? ''] ?? data.contentType}. Bài sẽ xuất hiện ở Duyệt bài hoặc Lịch & backlog sau ít phút, và được đăng ở đầu giờ kế tiếp.` });
        setText('');
        setAlbumTitle('');
        clearAll();
        setRights(false);
        router.refresh();
      } catch {
        setMsg({ kind: 'err', text: 'Không kết nối được máy chủ' });
      }
    });
  };

  const valid = sourceId && origin.trim().length >= 3 && rights && (text.trim() || items.length > 0);
  const total = items.reduce((n, i) => n + i.file.size, 0);
  return (
    <section className="card">
      <div className="row">
        <div className="field">
          <label htmlFor="src">Nguồn</label>
          <select id="src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ttl">Tên album (chỉ lưu kèm bài, không đăng thành album có tên)</label>
          <input id="ttl" value={albumTitle} onChange={(e) => setAlbumTitle(e.target.value)} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="txt">Nội dung chữ</label>
        <textarea id="txt" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="media">Ảnh hoặc video — tối đa {MAX_IMAGES} ảnh, hoặc 1 video (JPG, PNG, WebP, GIF, MP4, MOV, ≤120 MB/tệp)</label>
        <div className="actions">
          <input
            id="media"
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT.join(',')}
            onChange={(e) => addFiles(e.target.files)}
            disabled={hasVideo || items.length >= MAX_IMAGES}
            style={{ maxWidth: 420 }}
          />
          {items.length > 0 && <button type="button" className="sm" onClick={clearAll}>Bỏ hết</button>}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {items.length === 0
            ? 'Có thể chọn nhiều lần: mỗi lần chọn sẽ được thêm vào danh sách.'
            : `${items.length} tệp · ${mb(total)} · ${hasVideo ? 'bài video' : items.length > 1 ? `bài ${items.length} ảnh — đăng theo đúng thứ tự dưới đây` : 'bài 1 ảnh'}`}
        </div>
        {pickErr && <p className="err" role="alert">{pickErr}</p>}

        {items.length > 0 && (
          <div className="media" style={{ marginTop: 10 }}>
            {items.map((it, idx) => (
              <figure key={it.id} style={{ margin: 0, width: 120 }}>
                <div className="m" style={{ width: 120, height: 120, position: 'relative' }}>
                  {it.video ? <video src={it.url} muted preload="metadata" /> : /* eslint-disable-next-line @next/next/no-img-element */ <img src={it.url} alt={`Ảnh ${idx + 1}`} />}
                  <span className="badge info" style={{ position: 'absolute', top: 4, left: 4 }}>{idx + 1}</span>
                </div>
                <figcaption className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.file.name}>
                  {it.file.name}
                </figcaption>
                <div className="actions" style={{ gap: 4, marginTop: 2 }}>
                  <button type="button" className="sm" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label={`Đưa ảnh ${idx + 1} lên trước`}>←</button>
                  <button type="button" className="sm" onClick={() => move(idx, 1)} disabled={idx === items.length - 1} aria-label={`Đưa ảnh ${idx + 1} ra sau`}>→</button>
                  <button type="button" className="sm danger" onClick={() => remove(it.id)} aria-label={`Bỏ ${it.file.name}`}>✕</button>
                </div>
              </figure>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="org">Nội dung này từ đâu và vì sao được sử dụng lại (bắt buộc, được lưu cùng bài)</label>
        <input id="org" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="VD: Ảnh và bài do phòng truyền thông tự sản xuất, ngày 20/11" />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ width: 'auto' }} />
        Tôi xác nhận tổ chức có quyền sử dụng nội dung và media này.
      </label>
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="primary" disabled={pending || !valid} onClick={submit}>{pending ? `Đang tải lên${total ? ` ${mb(total)}` : ''}…` : 'Nhập bài'}</button>
        {!valid && !pending && (
          <span className="muted">
            {!origin.trim() || origin.trim().length < 3 ? 'Cần ghi nguồn gốc. ' : ''}
            {!rights ? 'Cần tick xác nhận quyền. ' : ''}
            {!text.trim() && items.length === 0 ? 'Cần nội dung chữ hoặc ảnh/video.' : ''}
          </span>
        )}
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'okmsg' : 'err'} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</p>}
    </section>
  );
}
