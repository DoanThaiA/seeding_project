import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty, Head } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { fmtTime, label, reasonText } from '@/lib/format';

interface Pub {
  id: string;
  status: string;
  contentType: string;
  workflow: string;
  permalink: string | null;
  lastReason: string | null;
  publishTries: number;
  createdAt: string;
  updatedAt: string;
  target: { code: string };
}

const FILTERS: Array<[string, string]> = [
  ['', 'Tất cả'],
  ['PUBLISHED_VERIFIED', 'Đã đăng'],
  ['UNKNOWN', 'Chưa rõ'],
  ['RECONCILING', 'Đang đối soát'],
  ['NEEDS_OPERATOR', 'Cần người'],
  ['FAILED_CONFIRMED', 'Thất bại'],
  ['OPERATOR_CONFIRMED', 'Người xác nhận'],
  ['CANCELLED', 'Đã hủy'],
  ['QUEUED', 'Chờ chạy'],
];

export default async function Publications({ searchParams }: { searchParams: Promise<{ status?: string; target?: string }> }) {
  const { status = '', target = '' } = await searchParams;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (target) qs.set('target', target);
  const [pubs, targets] = await Promise.all([apiGet<Pub[]>(`/publications${qs.size ? `?${qs}` : ''}`), apiGet<Array<{ code: string }>>('/targets')]);
  const href = (st: string, tg: string) => `/publications?${new URLSearchParams({ ...(st ? { status: st } : {}), ...(tg ? { target: tg } : {}) })}`;
  return (
    <>
      <AutoRefresh seconds={20} />
      <Head title="Bài đã đăng" sub="Mọi lượt đăng, mới nhất ở trên (tối đa 200). “Chưa rõ” không phải thành công." />
      <div className="filters" role="group" aria-label="Lọc theo trạng thái">
        {FILTERS.map(([k, l]) => <Link key={k} href={href(k, target)} aria-current={status === k}>{l}</Link>)}
      </div>
      <div className="filters" role="group" aria-label="Lọc theo tài khoản">
        <Link href={href(status, '')} aria-current={target === ''}>Mọi tài khoản</Link>
        {targets.map((t) => <Link key={t.code} href={href(status, t.code)} aria-current={target === t.code}>{t.code}</Link>)}
      </div>
      <div className="card">
        {pubs.length === 0 ? <Empty>Không có bản ghi.</Empty> : (
          <div className="tw">
            <table>
              <thead><tr><th>Cập nhật</th><th>Tài khoản</th><th>Định dạng</th><th>Trạng thái</th><th>Ghi chú</th><th></th></tr></thead>
              <tbody>
                {pubs.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtTime(p.updatedAt)}</td>
                    <td><strong>{p.target.code}</strong></td>
                    <td>{label(p.contentType)}</td>
                    <td><Badge s={p.status} />{p.publishTries > 1 && <span className="muted"> · lần {p.publishTries}</span>}</td>
                    <td className="muted">{p.lastReason ? reasonText(p.lastReason) : ''}</td>
                    <td><Link href={`/publications/${p.id}`}>Chi tiết</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
