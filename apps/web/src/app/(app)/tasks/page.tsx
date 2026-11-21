import Link from 'next/link';
import { AutoRefresh, ActionButton } from '@/components/client';
import { Badge, Empty, Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ago, fmtTime, reasonText } from '@/lib/format';
import { ResolveForm } from './ResolveForm';

interface Task {
  id: string;
  kind: 'REVIEW_CONTENT' | 'TAKEOVER_ACCOUNT' | 'CONFIRM_RESULT';
  status: string;
  targetId: string | null;
  publicationId: string | null;
  variantId: string | null;
  reason: string;
  details: Record<string, unknown> | null;
  claimedBy: string | null;
  createdAt: string;
}

const KIND_VI = { REVIEW_CONTENT: 'Duyệt nội dung', TAKEOVER_ACCOUNT: 'Tiếp quản tài khoản', CONFIRM_RESULT: 'Xác nhận kết quả' } as const;
const ORDER = { CONFIRM_RESULT: 0, TAKEOVER_ACCOUNT: 1, REVIEW_CONTENT: 2 } as const;

export default async function Tasks() {
  const s = await getSession();
  const [open, claimed, targets] = await Promise.all([
    apiGet<Task[]>('/operator-tasks?status=OPEN', s.token),
    apiGet<Task[]>('/operator-tasks?status=CLAIMED', s.token),
    apiGet<Array<{ id: string; code: string }>>('/targets', s.token),
  ]);
  const code = (id: string | null) => targets.find((t) => t.id === id)?.code ?? '—';
  const tasks = [...open, ...claimed].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt));
  const now = Date.now();
  const operate = can.operate(s.role);

  return (
    <>
      <AutoRefresh seconds={10} />
      <Head title="Cần xử lý" sub="Việc hệ thống không tự giải quyết được. Xử lý theo thứ tự từ trên xuống: kết quả chưa rõ trước, rồi tài khoản bị dừng, rồi duyệt nội dung." />
      {tasks.length === 0 ? (
        <div className="card"><Empty>Không có việc nào đang chờ.</Empty></div>
      ) : (
        tasks.map((t) => (
          <section key={t.id} className="card">
            <div className="head" style={{ marginBottom: 6 }}>
              <div>
                <strong>{KIND_VI[t.kind]}</strong> · {code(t.targetId)} <Badge s={t.status} />
                <div className="muted">{fmtTime(t.createdAt)} ({ago(t.createdAt, now)}){t.claimedBy ? ` · nhận bởi ${t.claimedBy}` : ''}</div>
              </div>
              {operate && t.status === 'OPEN' && <ActionButton path={`operator-tasks/${t.id}/claim`} className="sm">Nhận việc</ActionButton>}
            </div>
            <p style={{ margin: '6px 0' }}>{t.reason.split(',').map(reasonText).join(' · ')}</p>

            {t.kind === 'REVIEW_CONTENT' && <Link href="/review">Mở màn hình duyệt →</Link>}
            {t.kind === 'CONFIRM_RESULT' && t.publicationId && <Link href={`/publications/${t.publicationId}`}>Mở bài để xác nhận →</Link>}
            {t.kind === 'TAKEOVER_ACCOUNT' && (
              <>
                <div className="alert warn" style={{ margin: '8px 0' }}>
                  Tài khoản này đã <strong>tự dừng</strong>. Mở profile trình duyệt của {code(t.targetId)} trên máy worker, tự xử lý (đăng nhập lại, xác minh, đóng cửa sổ lạ…). Hệ thống không tự vượt qua xác minh. Xong rồi mới bấm bên dưới; lượt đăng kế tiếp sẽ kiểm tra lại phiên và danh tính trước khi làm gì.
                </div>
                {operate ? <ResolveForm id={t.id} /> : <p className="muted">Bạn chỉ có quyền xem.</p>}
              </>
            )}
          </section>
        ))
      )}
    </>
  );
}
