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

const kinds = { CONFIRM_RESULT: 'Đối chiếu bài đăng', TAKEOVER_ACCOUNT: 'Phiên tài khoản' } as const;
type Intervention = keyof typeof kinds;

export default async function Tasks({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  const s = await getSession();
  const [open, claimed, targets] = await Promise.all([
    apiGet<Task[]>('/operator-tasks?status=OPEN', s.token),
    apiGet<Task[]>('/operator-tasks?status=CLAIMED', s.token),
    apiGet<Array<{ id: string; code: string }>>('/targets', s.token),
  ]);
  const code = (id: string | null) => targets.find((t) => t.id === id)?.code ?? '—';
  const interventions = [...open, ...claimed].filter((task): task is Task & { kind: Intervention } => task.kind !== 'REVIEW_CONTENT');
  const filter = kind === 'CONFIRM_RESULT' || kind === 'TAKEOVER_ACCOUNT' ? kind : undefined;
  const tasks = interventions.filter(task => !filter || task.kind === filter)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.createdAt.localeCompare(b.createdAt));
  const now = Date.now();
  const operate = can.operate(s.role);

  return (
    <>
      <AutoRefresh seconds={10} />
      <Head title="Cần xử lý" sub="Kiểm tra kết quả đăng chưa rõ và phiên Facebook gặp lỗi." />
      <nav className="filters" aria-label="Loại việc">
        <Link href="/tasks" aria-current={!filter ? 'true' : undefined}>Tất cả · {interventions.length}</Link>
        {(Object.keys(kinds) as Intervention[]).map(key => (
          <Link key={key} href={{ pathname: '/tasks', query: { kind: key } }} aria-current={filter === key ? 'true' : undefined}>
            {kinds[key]} · {interventions.filter(task => task.kind === key).length}
          </Link>
        ))}
      </nav>
      {tasks.length === 0 ? (
        <div className="card"><Empty>Không có việc nào đang chờ.</Empty></div>
      ) : (
        tasks.map((t) => (
          <section key={t.id} className="card">
            <div className="head" style={{ marginBottom: 6 }}>
              <div>
                <strong>{kinds[t.kind]}</strong> · {code(t.targetId)} <Badge s={t.status} />
                <div className="muted">{fmtTime(t.createdAt)} ({ago(t.createdAt, now)}){t.claimedBy ? ` · nhận bởi ${t.claimedBy}` : ''}</div>
              </div>
              {operate && t.status === 'OPEN' && <ActionButton path={`operator-tasks/${t.id}/claim`} className="sm">Nhận việc</ActionButton>}
            </div>
            <p style={{ margin: '6px 0' }}>{t.reason.split(',').map(reasonText).join(' · ')}</p>

            {t.kind === 'CONFIRM_RESULT' && t.publicationId && <Link href={`/publications/${t.publicationId}`}>Mở bài để xác nhận →</Link>}
            {t.kind === 'TAKEOVER_ACCOUNT' && (
              <>
                <div className="alert warn" style={{ margin: '8px 0' }}>
                  Mở hồ sơ trình duyệt {code(t.targetId)} trên máy worker để xử lý đăng nhập hoặc xác minh. Lượt đăng tiếp theo sẽ kiểm tra lại phiên trước khi gửi.
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
