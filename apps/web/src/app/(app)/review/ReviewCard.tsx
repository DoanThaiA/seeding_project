'use client';

import { useState } from 'react';
import { ActionButton, bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime, reasonText } from '@/lib/format';
import { ReviewMediaUpload } from './ReviewMediaUpload';

export interface ReviewItem {
  id: string;
  caption: string | null;
  contentType: string;
  reviewReasons: string[];
  createdAt: string;
  expiresAt: string | null;
  target: { code: string };
  revision: {
    text: string;
    albumTitle: string | null;
    incomplete: string[];
    mediaStatus: string;
    sharedPermalink: string | null;
    post: { permalink: string | null; contentType: string; isShared: boolean; identityConfidence: string; source: { code: string; connector: string } };
    assets: Array<{ position: number; asset: { id: string; kind: string; status: string; mime: string | null } }>;
  };
  checks: Array<{ id: string; kind: string; passed: boolean; details: Record<string, unknown> | null }>;
}

const CHECK_VI: Record<string, string> = { facts_preserved: 'Giữ số liệu/dữ kiện', negation_kept: 'Giữ ý phủ định', length: 'Độ dài' };

function Thumb({ a }: { a: ReviewItem['revision']['assets'][number] }) {
  const [broken, setBroken] = useState(false);
  const src = `/bff/assets/${a.asset.id}/content`;
  return (
    <div className="m" title={`#${a.position + 1} · ${a.asset.status}`}>
      {broken || a.asset.status !== 'STORED' ? (
        <span>{a.asset.kind === 'video' ? 'Video' : 'Ảnh'} #{a.position + 1}<br />{a.asset.status !== 'STORED' ? 'chưa tải' : ''}</span>
      ) : a.asset.kind === 'video' ? (
        <video src={src} controls preload="metadata" onError={() => setBroken(true)} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`Ảnh ${a.position + 1}`} onError={() => setBroken(true)} /></a>
      )}
    </div>
  );
}

export function ReviewCard({ v, canAct }: { v: ReviewItem; canAct: boolean }) {
  const [caption, setCaption] = useState(v.caption ?? v.revision.text);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const s = useSubmit();
  const edited = caption.trim() !== (v.caption ?? v.revision.text).trim();
  const missingMedia = v.revision.incomplete.some(flag => flag === 'MEDIA_UNAVAILABLE' || flag === 'MEDIA_COUNT_UNKNOWN');
  const mediaOk = !missingMedia && ['READY', 'NOT_REQUIRED'].includes(v.revision.mediaStatus)
    && (!['VIDEO', 'REEL'].includes(v.contentType) || (v.revision.assets.length === 1 && v.revision.assets[0].asset.kind === 'video'))
    && v.revision.assets.every((a) => a.asset.status === 'STORED');
  const validCaption = v.contentType === 'REEL' || !!caption.trim();
  const share = v.revision.sharedPermalink;
  const failed = v.checks.filter((c) => !c.passed && c.kind !== 'not_verbatim');

  return (
    <section className="card">
      <div className="head" style={{ marginBottom: 10 }}>
        <div>
          <strong>{v.revision.post.source.code} → {v.target.code}</strong> <Badge s={v.contentType} />
          {v.revision.post.isShared && <> <Badge s="DEFERRED" text="Bài chia sẻ" /></>}
          <div className="muted">Vào hàng chờ {fmtTime(v.createdAt)}{v.expiresAt ? ` · hết hiệu lực ${fmtTime(v.expiresAt)}` : ''}</div>
        </div>
        {v.revision.post.permalink && <a href={v.revision.post.permalink} target="_blank" rel="noreferrer">Mở bài gốc</a>}
      </div>

      <div className="chips">
        {[...new Set([...(v.reviewReasons ?? []), ...v.revision.incomplete])].filter(r => r !== 'NEAR_VERBATIM_COPY').map((r) => (
          <span key={r} className="badge warn">{reasonText(r)}</span>
        ))}
      </div>

      <div className="rev">
        <div>
          <label>Bài gốc{v.revision.albumTitle ? ` · album “${v.revision.albumTitle}”` : ''}</label>
          <div className="quote">{v.revision.text || '(không có chữ)'}</div>
          {v.revision.assets.length > 0 && (
            <div className="media">{v.revision.assets.map((a) => <Thumb key={a.asset.id} a={a} />)}</div>
          )}
          {!mediaOk && <p className={share ? 'muted' : 'err'}>{share ? 'Bản lưu media chưa tải đủ.' : 'Chưa có đủ media đã tải để duyệt.'}</p>}
          {canAct && !share && (missingMedia || v.revision.mediaStatus === 'FAILED') && ['fb-public', 'fb-session'].includes(v.revision.post.source.connector)
            && ['VIDEO', 'REEL', 'SINGLE_PHOTO', 'MULTI_PHOTO'].includes(v.contentType)
            && <ReviewMediaUpload id={v.id} video={v.contentType === 'VIDEO' || v.contentType === 'REEL'} />}
        </div>
        <div>
          <label htmlFor={`cap-${v.id}`}>{share ? 'Caption để dùng khi chia sẻ' : `Caption đăng lên ${v.target.code}`} {edited && <span className="badge info">đã sửa</span>}</label>
          <textarea id={`cap-${v.id}`} value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!canAct} maxLength={5000} placeholder={share ? 'Thêm lời chia sẻ nếu cần' : 'Nhập caption hoặc chọn Viết lại bằng AI'} />
          {!share && failed.length > 0 && (
            <div className="chips">
              {failed.map((c) => (
                <span key={c.id} className="badge bad" title={JSON.stringify(c.details)}>Không đạt: {CHECK_VI[c.kind] ?? c.kind}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {share && (
        <div style={{ marginTop: 12 }}>
          {canAct && <a href={share} target="_blank" rel="noreferrer">Mở bài gốc để chia sẻ</a>}
          <p className="muted">Kiểm tra đang dùng {v.target.code} rồi chọn Chia sẻ trên Facebook. Bạn có thể dán caption vào bài chia sẻ.</p>
        </div>
      )}

      {canAct && (
        <div style={{ marginTop: 12 }}>
          {rejecting ? (
            <div className="row">
              <div className="field">
                <label htmlFor={`rj-${v.id}`}>Lý do loại</label>
                <input id={`rj-${v.id}`} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </div>
              <div className="actions">
                <button className="danger" disabled={s.pending || !reason.trim()} onClick={() => s.run(() => bff('POST', `review/${v.id}/reject`, { reason: reason.trim() }), 'Đã loại')}>Xác nhận loại</button>
                <button onClick={() => setRejecting(false)}>Hủy</button>
              </div>
            </div>
          ) : (
            <div className="actions">
              {!share && <button
                className="primary"
                disabled={s.pending || !mediaOk || v.contentType === 'UNSUPPORTED' || !validCaption}
                onClick={() => s.run(() => bff('POST', `review/${v.id}/approve`, { caption: caption.trim() }), 'Đã duyệt')}
              >
                {edited ? 'Duyệt với caption đã sửa' : 'Duyệt'}
              </button>}
              <button disabled={s.pending || !edited || (!caption.trim() && (!validCaption || !!share))}
                onClick={() => s.run(() => bff('PATCH', `review/${v.id}/caption`, { caption }), 'Đã lưu caption')}>Lưu caption</button>
              {!share && <ActionButton path={`review/${v.id}/rewrite`} confirm="Cho AI viết lại caption từ bài gốc? Caption hiện tại sẽ bị thay.">Viết lại bằng AI</ActionButton>}
              <button className="danger" onClick={() => setRejecting(true)}>Loại bài</button>
            </div>
          )}
          {s.error && <p className="err" role="alert">{s.error}</p>}
          {s.done && <p className="okmsg">{s.done}</p>}
        </div>
      )}
    </section>
  );
}
