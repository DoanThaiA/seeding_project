import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/client';
import { Badge, Head } from '@/components/ui';
import { ApiError, apiGet, can, getSession } from '@/lib/api';
import { fmtTime, label, reasonText } from '@/lib/format';
import { ConfirmPanel } from './ConfirmPanel';

interface Detail {
  id: string;
  status: string;
  contentType: string;
  workflow: string;
  permalink: string | null;
  externalPostId: string | null;
  lastReason: string | null;
  publishTries: number;
  reconcileTries: number;
  committedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  target: { code: string; externalId: string; audience: string };
  variant: { caption: string | null; snapshotHash: string | null };
  attempts: Array<{ id: string; attemptNo: number; kind: string; connector: string; connectorVersion: string; outcome: string; stage: string | null; errorClass: string | null; errorMessage: string | null; startedAt: string; finishedAt: string | null; fencingToken: string }>;
  history: Array<{ id: string; action: string; fromState: string | null; toState: string | null; actor: string; at: string; data: { reason?: string } | null }>;
}

export default async function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  let p: Detail;
  try {
    p = await apiGet<Detail>(`/publications/${encodeURIComponent(id)}`, s.token);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const live = ['QUEUED', 'PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', 'COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING', 'UNKNOWN', 'RECONCILING'].includes(p.status);
  return (
    <>
      {live && <AutoRefresh seconds={5} />}
      <Head title={`${p.target.code} · ${label(p.contentType)}`} sub="Chi tiết một lượt đăng" right={<Link href="/publications">← Danh sách</Link>} />

      <section className="card">
        <dl className="kv">
          <dt>Trạng thái</dt><dd><Badge s={p.status} /> {p.lastReason && <span className="muted">{reasonText(p.lastReason)}</span>}</dd>
          <dt>Tài khoản đích</dt><dd>{p.target.code} <span className="mono muted">({p.target.externalId})</span> · {p.target.audience === 'ONLY_ME' ? 'Chỉ mình tôi' : p.target.audience}</dd>
          <dt>Workflow</dt><dd>{p.workflow}</dd>
          <dt>Bấm đăng lúc</dt><dd>{fmtTime(p.committedAt)}</dd>
          <dt>Xác minh lúc</dt><dd>{fmtTime(p.verifiedAt)}</dd>
          <dt>Liên kết bài</dt><dd className="mono">{p.permalink ?? '—'}</dd>
          <dt>Số lần thử</dt><dd>đăng {p.publishTries} · đối soát {p.reconcileTries}</dd>
          <dt>Caption</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.variant.caption}</dd>
        </dl>
      </section>

      {p.status === 'NEEDS_OPERATOR' && (
        can.operate(s.role) ? <ConfirmPanel id={p.id} /> : <div className="alert warn" style={{ marginBottom: 16 }}>Cần người vận hành xác nhận kết quả.</div>
      )}
      {(p.status === 'UNKNOWN' || p.status === 'RECONCILING') && (
        <div className="alert warn" style={{ marginBottom: 16 }}>Hệ thống đang đối soát tự động bằng cách tìm bài trên trang. Nếu không xác định được, bài sẽ chuyển cho người vận hành. <strong>Đừng đăng tay lại</strong> khi chưa kiểm tra.</div>
      )}

      <section className="card">
        <h2>Các lần thực hiện</h2>
        <div className="tw">
          <table>
            <thead><tr><th>#</th><th>Loại</th><th>Bắt đầu</th><th>Kết thúc</th><th>Kết quả</th><th>Giai đoạn cuối</th><th>Connector</th></tr></thead>
            <tbody>
              {p.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.attemptNo}</td>
                  <td>{a.kind}</td>
                  <td>{fmtTime(a.startedAt)}</td>
                  <td>{fmtTime(a.finishedAt)}</td>
                  <td>{a.outcome}{a.errorClass && <div className="muted mono">{a.errorClass}{a.errorMessage ? ` — ${a.errorMessage}` : ''}</div>}</td>
                  <td>{a.stage ?? '—'}</td>
                  <td className="mono">{a.connector}@{a.connectorVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Lịch sử trạng thái</h2>
        <ul className="timeline">
          {p.history.map((h) => (
            <li key={h.id}>
              <span className="t">{fmtTime(h.at)}</span>
              <span>
                {h.fromState ? `${h.fromState} → ` : ''}<strong>{h.toState ?? h.action}</strong>
                <span className="muted"> · {h.actor}{h.data?.reason ? ` · ${h.data.reason}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
