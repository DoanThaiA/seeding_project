'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { bff, useSubmit } from '@/components/client';
import { fmtTime } from '@/lib/format';
import type { ProfileSyncOption } from '../library/types';
import styles from './profile-sync.module.css';

const PHASE = { DISCOVERING: 'Đang đọc lịch sử', PREPARING: 'Đang chuẩn bị bài và bình luận', PREPARED: 'Đã chuẩn bị', FAILED: 'Lượt chạy gián đoạn' };
const reasons: Record<string, string> = {
  ACCOUNT_BUSY: 'Đích đang xử lý bài trước', PUBLISH_INTERVAL_NOT_ELAPSED: 'Chờ đến khoảng cách đăng đã cấu hình',
  UNRESOLVED_PUBLICATION: 'Cần đối chiếu kết quả đăng trên Facebook', TARGET_DISABLED: 'Tài khoản đích đang tắt',
  NO_WORKER: 'Đang chờ worker của tài khoản đích', NO_CONNECTOR_RELEASE: 'Chưa có kết nối đăng đang hoạt động',
  FORMAT_UNSUPPORTED: 'Định dạng chưa hỗ trợ', FORMAT_NOT_CERTIFIED: 'Định dạng chưa được xác nhận cho đích',
  SOURCE_INCOMPLETE: 'Bài nguồn chưa đủ dữ liệu để đăng', MEDIA_PENDING: 'Đang tải ảnh hoặc video',
  MEDIA_INCOMPLETE: 'Bài nguồn thiếu ảnh hoặc video', CONTENT_PENDING: 'Đang xử lý nội dung',
  NATIVE_SHARE_REQUIRED: 'Bài cần chia sẻ gốc trên Facebook', REVIEW_REQUIRED: 'Bài này cần duyệt riêng',
  SOURCE_REVISION_CHANGED: 'Bản nguồn vừa thay đổi. Cần chạy lại đồng bộ', ITEM_UNAVAILABLE: 'Bài hoặc luồng hiện không khả dụng',
  AUDIENCE_CONFIG_CHANGED: 'Quyền xem của bản duyệt khác cài đặt đích', RETRY_LIMIT_REACHED: 'Đã hết số lần thử đăng',
  FAILED_CONFIRMED: 'Lượt đăng thất bại', CANCELLED: 'Lượt đăng đã dừng',
  DUPLICATE_PENDING: 'Đang đợi xác minh bài cùng nội dung', DUPLICATE_CONTENT: 'Đang đợi xác minh bài cùng nội dung',
};
const states: Record<string, string> = {
  POSTED: 'Đã có ở đích', CHANGED: 'Nguồn khác bản đã đăng', DUPLICATE: 'Trùng nội dung đã đăng',
  WORKING: 'Worker đang đăng', WAITING: 'Chờ worker', CHECK: 'Cần đối chiếu', BLOCKED: 'Chưa thể đăng',
};

function SyncComparison({ syncId, source, target, active }: { syncId: string; source: string; target: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Array<{ postId: string; caption: string; state: string; reason: string | null;
    permalink: string | null }>; more: boolean }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/bff/library/syncs/${syncId}/items?filter=${filter}&page=${page}`, { signal: abort.signal });
        if (!response.ok) throw new Error('sync comparison');
        const result = await response.json();
        if (!abort.signal.aborted) { setData(result); setError(false); }
      } catch {
        if (!abort.signal.aborted) setError(true);
      }
    };
    setData(undefined);
    setError(false);
    void load();
    const timer = active ? window.setInterval(() => { void load(); }, 8000) : undefined;
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [open, filter, page, syncId, active]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Đối chiếu từng bài</summary>
    <div className={styles.syncForm}>
      <label>Trạng thái bài
        <select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
          <option value="all">Tất cả bài trong lượt</option>
          <option value="posted">Đã có ở {target}</option>
          <option value="missing">Còn thiếu hoặc cần kiểm tra</option>
          <option value="changed">Khác bản đã đăng</option>
        </select>
      </label>
    </div>
    {error ? <p role="alert" className="err">Không tải được danh sách đối chiếu.</p> : !data ? <p>Đang tải…</p> : data.items.length ? <>
      <div className="tw"><table>
        <thead><tr><th>Bài nguồn</th><th>Trạng thái</th><th>Bài ở {target}</th></tr></thead>
        <tbody>{data.items.map(row => <tr key={row.postId}>
          <td><Link href={{ pathname: '/library', query: { profile: source, post: row.postId, to: target } }}>{row.caption || 'Mở bài nguồn'}</Link></td>
          <td>{states[row.state]}{row.reason && <div className="muted">{reasons[row.reason] ??
            (row.reason.startsWith('KILL_SWITCH_') ? 'Đang tạm dừng trong hệ thống' : row.reason)}</div>}</td>
          <td>{row.permalink && <a href={row.permalink} target="_blank" rel="noreferrer">Mở bài đã đăng</a>}</td>
        </tr>)}</tbody>
      </table></div>
    </> : <p className="muted">Chưa có bài trong nhóm này.</p>}
    {(data?.more || page > 1) && <div className="actions">
      <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Trang trước</button>
      <span>Trang {page}</span>
      <button type="button" disabled={!data?.more} onClick={() => setPage(page + 1)}>Trang sau</button>
    </div>}
  </details>;
}

export function ProfileSyncPanel({ code, connector, enabled, option, canOperate, canReview }: {
  code: string; connector: string; enabled: boolean; option: ProfileSyncOption; canOperate: boolean; canReview: boolean;
}) {
  const { target, latest } = option;
  const canReadHistory = enabled && ['fb-session','fb-public','fb-graph'].includes(connector) && (connector !== 'fb-session' || target.enabled);
  const [history, setHistory] = useState(canReadHistory);
  const submit = useSubmit();
  const approval = useSubmit();
  const [added, setAdded] = useState<number>();
  const stats = latest?.stats;
  const scanning = latest?.phase === 'DISCOVERING' || latest?.phase === 'PREPARING';
  const publishing = !!latest?.publish && !!stats && stats.waiting + stats.working > 0;
  return (
    <section className={styles.panel} aria-labelledby="sync-post-heading">
      <header className={styles.panelHeading}>
        <h2 id="sync-post-heading">Bài viết và bình luận</h2>
        {canOperate && <div className={styles.syncForm}>
          <label>Phạm vi
            <select value={history && canReadHistory ? 'history' : 'archive'} onChange={e => setHistory(e.target.value === 'history')}>
              <option value="history" disabled={!canReadHistory}>Quét lịch sử nguồn</option>
              <option value="archive">Dùng bài và bình luận đã lưu</option>
            </select>
          </label>
          <button className="primary" type="button" disabled={submit.pending || scanning || publishing || !target.enabled} onClick={() => {
            if (!window.confirm(`Đối chiếu hồ sơ ${code} → ${target.code} và giao bài đủ điều kiện còn thiếu cho worker đăng?`)) return;
            submit.run(() => bff('POST', `library/profiles/${code}/syncs`, { targetId: target.id, history: history && canReadHistory, publish: true }),
              'Đã giao lượt đồng bộ cho worker.');
          }}>{submit.pending ? 'Đang gửi…' : 'Đồng bộ và đăng ngay'}</button>
        </div>}
      </header>
      {!target.enabled && <p className="muted">Cần bật {target.code} để đồng bộ bài viết.</p>}
      {target.enabled && !latest && <p className="muted">Worker đối chiếu bài đã đăng và xử lý bài đủ điều kiện còn thiếu theo tùy chọn bình luận của nguồn.</p>}
      {latest && <div className={styles.syncStatus}>
        <strong role="status">{latest.publish && latest.phase === 'PREPARED' ? publishing ? 'Worker đang xử lý' : 'Đã kiểm tra hàng đăng' : PHASE[latest.phase]} · {fmtTime(latest.updatedAt)}</strong>
        {latest.history && latest.phase === 'PREPARED' && <span>{latest.historyDone ? 'Đã đọc hết các trang lịch sử kết nối trả về.' : 'Lịch sử nguồn có thể còn bài chưa đọc được.'}</span>}
        {latest.detail && <span>{latest.detail}</span>}
        {scanning && <progress aria-label="Tiến độ quét và chuẩn bị đồng bộ" />}
        {stats && <div className={styles.syncStats}>
          <div><strong>{stats.posts}</strong><span>Bài trong lượt</span></div>
          {latest.publish ? <>
            <div><strong>{stats.waiting}</strong><span>Chờ worker</span></div>
            <div><strong>{stats.working}</strong><span>Đang đăng</span></div>
            <div><strong>{stats.duplicates}</strong><span>Trùng nội dung</span></div>
            <div><strong>{stats.needsCheck}</strong><span>Cần đối chiếu trên Facebook</span></div>
            <div><strong>{stats.blocked}</strong><span>Chưa thể đăng</span></div>
          </> : <>
            <div><strong>{stats.toReview}</strong><span>Chờ duyệt</span></div>
            <div><strong>{stats.approved}</strong><span>Sẵn sàng đăng</span></div>
          </>}
          <div><strong>{stats.posted}</strong><span>Đã có ở {target.code}</span></div>
          <div><strong>{stats.changed}</strong><span>Khác bản nguồn</span></div>
        </div>}
        {latest.publish && !!stats?.posts && <SyncComparison key={latest.id} syncId={latest.id} source={code} target={target.code}
          active={scanning || publishing || stats.needsCheck > 0} />}
        {stats && <details>
          <summary>Ảnh, video và bình luận</summary>
          <div className={styles.syncStats}>
            <div><strong>{stats.missingMedia}</strong><span>Bài thiếu ảnh hoặc video</span></div>
            <div><strong>{stats.scansComplete}/{stats.posts}</strong><span>Bài đã quét xong bình luận</span></div>
            <div><strong>{stats.scansPending}</strong><span>Bài đang chờ quét bình luận</span></div>
            <div><strong>{stats.scansPartial}</strong><span>Bài quét bình luận còn thiếu</span></div>
            {!!stats.scansUnrequested && <div><strong>{stats.scansUnrequested}</strong><span>Bài chưa yêu cầu quét bình luận</span></div>}
            <div><strong>{stats.commentsDrafted}/{stats.comments}</strong><span>Bình luận đã chuẩn bị</span></div>
            <div><strong>{stats.commentsPosted}/{stats.comments}</strong><span>Bình luận đã ghi nhận ở đích</span></div>
          </div>
        </details>}
      </div>}
      {canReview && latest?.phase === 'PREPARED' && !latest.publish && !!stats?.toReview && <button type="button" disabled={approval.pending} onClick={() => {
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
    </section>
  );
}
