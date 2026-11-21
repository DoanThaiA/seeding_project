'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';
import { fmtTime } from '@/lib/format';
import type { ProfileSyncOption } from './types';
import styles from './library.module.css';

const PHASE = { DISCOVERING: 'Đang đọc lịch sử', PREPARING: 'Đang chuẩn bị bài và bình luận', PREPARED: 'Đã chuẩn bị', FAILED: 'Lượt chạy gián đoạn' };

export function ProfileSyncPanel({ code, connector, enabled, options, canOperate, canReview }: {
  code: string; connector: string; enabled: boolean; options: ProfileSyncOption[]; canOperate: boolean; canReview: boolean;
}) {
  const [targetId, setTargetId] = useState(options[0]?.target.id ?? '');
  const [history, setHistory] = useState(enabled && (connector !== 'fb-session' || !!options[0]?.target.enabled));
  const submit = useSubmit();
  const approval = useSubmit();
  const [added, setAdded] = useState<number>();
  const option = options.find(o => o.target.id === targetId) ?? options[0];
  if (!option) return null;
  const { target, latest } = option;
  const canReadHistory = enabled && ['fb-session','fb-public','fb-graph'].includes(connector) && (connector !== 'fb-session' || target.enabled);
  const running = latest?.phase === 'DISCOVERING' || latest?.phase === 'PREPARING';
  const stats = latest?.stats;
  return (
    <details className={styles.syncPanel} open={running || !!latest}>
      <summary>Đồng bộ profile {code} → {target.code}</summary>
      <div className={styles.syncForm}>
        <label>Profile đích
          <select value={target.id} onChange={e => {
            setTargetId(e.target.value);
            if (connector === 'fb-session' && !options.find(o => o.target.id === e.target.value)?.target.enabled) setHistory(false);
          }}>
            {options.map(o => <option key={o.target.id} value={o.target.id}>{o.target.code} · {o.target.name}</option>)}
          </select>
        </label>
        {canOperate && <>
          <label>Phạm vi
            <select value={history && canReadHistory ? 'history' : 'archive'} onChange={e => setHistory(e.target.value === 'history')}>
              <option value="history" disabled={!canReadHistory}>Quét lịch sử nguồn và bình luận</option>
              <option value="archive">Dùng bài và bình luận đã lưu</option>
            </select>
          </label>
          <button className="primary" type="button" disabled={submit.pending || !!running} onClick={() =>
            submit.run(() => bff('POST', `library/profiles/${code}/syncs`, { targetId: target.id, history: history && canReadHistory }),
              'Đã gửi lượt đồng bộ')}>Chuẩn bị đồng bộ</button>
        </>}
      </div>
      <p className="muted">Bài mới vào hàng duyệt. Bài đã có ở đích được đối chiếu theo lịch sử đăng trong SeedingSys.</p>
      {latest && <div className={styles.syncStatus} role="status">
        <strong>{PHASE[latest.phase]} · {fmtTime(latest.updatedAt)}</strong>
        {latest.history && latest.phase === 'PREPARED' && <span>{latest.historyDone ? 'Đã đọc hết các trang lịch sử kết nối trả về.' : 'Lịch sử nguồn có thể còn bài chưa đọc được.'}</span>}
        {latest.detail && <span>{latest.detail}</span>}
        {running && <progress aria-label="Tiến độ chuẩn bị đồng bộ" />}
        {stats && <div className={styles.syncStats}>
          <div><strong>{stats.posts}</strong><span>Bài trong lượt</span></div>
          <div><strong>{stats.toReview}</strong><span>Chờ duyệt</span></div>
          <div><strong>{stats.approved}</strong><span>Sẵn sàng đăng</span></div>
          <div><strong>{stats.posted}</strong><span>Đã có ở {target.code}</span></div>
          <div><strong>{stats.changed}</strong><span>Khác bản nguồn</span></div>
          <div><strong>{stats.missingMedia}</strong><span>Chờ đủ media</span></div>
          <div><strong>{stats.scansComplete}/{stats.posts}</strong><span>Bài đã quét xong bình luận</span></div>
          <div><strong>{stats.scansPending} / {stats.scansPartial}</strong><span>Lượt quét chờ / thiếu</span></div>
          {!!stats.scansUnrequested && <div><strong>{stats.scansUnrequested}</strong><span>Bài chưa quét bình luận</span></div>}
          <div><strong>{stats.commentsDrafted}/{stats.comments}</strong><span>Bình luận có bản sao để duyệt</span></div>
          <div><strong>{stats.commentsPosted}/{stats.comments}</strong><span>Bình luận đã ghi nhận ở đích</span></div>
        </div>}
      </div>}
      {canReview && latest?.phase === 'PREPARED' && !!stats?.toReview && <button type="button" disabled={approval.pending} onClick={() => {
        if (!window.confirm(`Duyệt tối đa 50 bài có caption gốc và đủ nội dung để vào hàng đăng của ${target.code}?`)) return;
        setAdded(undefined);
        approval.run(async () => {
          const result = await bff<{ approved: number }>('POST', `library/syncs/${latest.id}/approve`);
          if (result.ok) setAdded(result.data.approved);
          return result;
        });
      }}>Duyệt tối đa 50 bài đủ điều kiện</button>}
      {approval.error && <p className="err" role="alert">{approval.error}</p>}
      {added !== undefined && <p className="okmsg" role="status">{added ? `Đã duyệt ${added} bài.` : 'Các bài còn lại cần mở để kiểm tra và duyệt riêng.'}</p>}
      {submit.error && <p className="err" role="alert">{submit.error}</p>}
      {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    </details>
  );
}
