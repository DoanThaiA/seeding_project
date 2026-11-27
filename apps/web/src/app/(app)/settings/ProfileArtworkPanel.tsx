'use client';

import { bff, useSubmit } from '@/components/client';
import { fmtTime } from '@/lib/format';
import { Panel } from './SettingsForms';
import styles from './settings.module.css';

type Photo = { photoId: string; width: number; height: number; extension: string };

export interface ProfileArtworkView {
  mappingId: string;
  requestId: string;
  updatedAt: string;
  status: string;
  error: string | null;
  images: { avatar: Photo; cover: Photo } | null;
  apply?: { status: string; error: string | null; kind: string | null; avatarId: string | null; coverId: string | null };
}

export function ProfileArtworkPanel({ mappingId, source, target, targetExternalId, artwork }: {
  mappingId: string; source: string; target: string; targetExternalId: string; artwork?: ProfileArtworkView;
}) {
  const read = useSubmit();
  const apply = useSubmit();
  const busy = read.pending || artwork?.status === 'QUEUED' || artwork?.status === 'READING';
  const applying = apply.pending || ['QUEUED', 'RUNNING', 'COMMITTING'].includes(artwork?.apply?.status ?? '');
  const needsCheck = artwork?.apply?.status === 'NEEDS_CHECK';
  const applied = artwork?.apply?.status === 'DONE';
  const partial = !applied && (artwork?.apply?.avatarId || artwork?.apply?.coverId);
  const externalId = targetExternalId.replace(/^@/, '');
  const targetLink = /^\d+$/.test(externalId) ? 'https://www.facebook.com/profile.php?id=' + externalId
    : /^[a-z\d.]+$/i.test(externalId) ? 'https://www.facebook.com/' + externalId : undefined;
  return <Panel title={`Ảnh trang cá nhân ${source} → ${target}`}
    right={<button type="button" disabled={busy || applying || needsCheck || !!partial} onClick={() => read.run(
      () => bff('POST', 'profile-artwork/' + mappingId + '/read'), 'Đã giao lượt lấy ảnh cho worker.',
    )}>{busy ? 'Đang lấy ảnh…' : artwork?.images ? 'Lấy lại ảnh nguồn' : 'Lấy ảnh từ ' + source}</button>}>
    {read.error && <p role="alert" className="err">{read.error}</p>}
    {artwork?.error && <p role="status" className="err">{artwork.error}</p>}
    {artwork?.images ? <>
      <div className={styles.artworkGrid}>
        {(['avatar', 'cover'] as const).map(kind => {
          const asset = artwork.images![kind];
          const label = kind === 'avatar' ? 'Ảnh đại diện' : 'Ảnh bìa';
          const url = `/bff/profile-artwork/${mappingId}/${kind}?request=${artwork.requestId}`;
          const appliedId = kind === 'avatar' ? artwork.apply?.avatarId : artwork.apply?.coverId;
          return <figure key={kind} className={styles.artwork}>
            <img src={url} alt={label + ' của ' + source} width={asset.width} height={asset.height} loading="lazy" />
            <figcaption>
              <strong>{label}</strong> <span className="muted">{asset.width} × {asset.height}</span>
              <a href={url + '&download=1'} download={`${source}-${target}-${kind}.${asset.extension}`}>Tải {label.toLowerCase()} cho {target}</a>
              {appliedId && <a href={`https://www.facebook.com/photo/?fbid=${appliedId}`} target="_blank" rel="noreferrer">
                Xem {label.toLowerCase()} đã xác minh trên {target}
              </a>}
            </figcaption>
          </figure>;
        })}
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy || applying || needsCheck || applied}
          onClick={() => {
            if (!window.confirm(`Thay ảnh đại diện và ảnh bìa trên Facebook ${target} bằng ảnh từ ${source}?`)) return;
            apply.run(() => bff('POST', 'profile-artwork/' + mappingId + '/apply', { requestId: artwork.requestId }), 'Đã giao lượt đồng bộ cho worker.');
          }}>{applying ? 'Đang đồng bộ…' : applied ? 'Đã đồng bộ cả hai ảnh' : partial ? 'Đồng bộ ảnh còn lại' : `Đồng bộ ảnh ${source} → ${target}`}</button>
        {targetLink && <a href={targetLink} target="_blank" rel="noreferrer">Mở trang Facebook {target}</a>}
        <span className="muted">Đã lấy {fmtTime(artwork.updatedAt)}</span>
      </div>
      {apply.error && <p role="alert" className="err">{apply.error}</p>}
      {apply.done && !applied && !needsCheck && !artwork.apply?.error && <p role="status" className="okmsg">{apply.done}</p>}
      {applied && <p role="status" className="okmsg">Đã xác minh cả hai ảnh mới trên Facebook {target}.</p>}
      {needsCheck && <p role="alert" className="err">Facebook chưa xác nhận ảnh đã lưu. Mở trang {target} để đối chiếu kết quả.</p>}
      {artwork.apply?.error && <p role="status" className="err">{artwork.apply.error}</p>}
    </> : !busy && !artwork?.error && <p className="muted">Lấy ảnh đại diện và ảnh bìa từ trang nguồn để xem trước và tải cho đích.</p>}
  </Panel>;
}
