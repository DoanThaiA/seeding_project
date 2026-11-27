import Link from 'next/link';
import { Empty, Head, Kpi } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { fmtTime, label, pct } from '@/lib/format';

interface Report {
  since: string;
  publications: Array<{ contentType: string; status: string; _count: number }>;
  targets: Array<{ code: string; name: string; outcomes: Array<{ status: string; _count: number }> }>;
  attempts: Array<{ outcome: string; _count: number }>;
  automatic: number;
  operatorConfirmed: number;
  llmUsd: number;
  llmUsdPerSuccess: number | null;
}

const OK = ['PUBLISHED_VERIFIED', 'OPERATOR_CONFIRMED'];
const UNRESOLVED = ['UNKNOWN', 'RECONCILING', 'NEEDS_OPERATOR'];
const INFLIGHT = ['QUEUED', 'PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', 'COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING'];

export default async function Reports({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days = '7' } = await searchParams;
  const d = ['1', '7', '30'].includes(days) ? days : '7';
  const r = await apiGet<Report>(`/reports/summary?days=${d}`);
  const formats = [...new Set(r.publications.map((p) => p.contentType))];
  const n = (ct: string, set: string[]) => r.publications.filter((p) => p.contentType === ct && set.includes(p.status)).reduce((a, p) => a + p._count, 0);
  const total = r.publications.reduce((a, p) => a + p._count, 0);
  const success = r.automatic + r.operatorConfirmed;
  return (
    <>
      <Head title="Báo cáo" sub={`Từ ${fmtTime(r.since)} đến nay`} />
      <div className="filters">
        {[['1', '24 giờ'], ['7', '7 ngày'], ['30', '30 ngày']].map(([k, l]) => <Link key={k} href={`/reports?days=${k}`} aria-current={d === k}>{l}</Link>)}
      </div>
      <div className="grid">
        <Kpi value={total} label="Lượt đăng" />
        <Kpi value={success} label="Đã đăng" kind="ok" />
        <Kpi value={r.publications.filter(row => UNRESOLVED.includes(row.status)).reduce((sum, row) => sum + row._count, 0)} label="Cần đối chiếu" />
      </div>

      <section className="card">
        <h2>Theo tài khoản đích</h2>
        {r.targets.length ? <div className="tw"><table>
          <thead><tr><th>Hồ sơ</th><th className="num">Đã đăng</th><th className="num">Đang chạy</th><th className="num">Cần đối chiếu</th><th className="num">Thất bại</th><th className="num">Đã hủy</th></tr></thead>
          <tbody>{r.targets.map(target => {
            const count = (statuses: string[]) => target.outcomes.reduce((sum, row) => sum + (statuses.includes(row.status) ? row._count : 0), 0);
            return <tr key={target.code}>
              <td><Link href={{ pathname: '/library', query: { profile: target.code } }}>{target.code} · {target.name}</Link></td>
              {[OK, INFLIGHT, UNRESOLVED, ['FAILED_CONFIRMED'], ['CANCELLED']].map(statuses => <td className="num" key={statuses[0]}>{count(statuses)}</td>)}
            </tr>;
          })}</tbody>
        </table></div> : <Empty>Chưa có lượt đăng trong khoảng này.</Empty>}
      </section>

      <section className="card">
        <h2>Theo định dạng</h2>
        {formats.length === 0 ? <Empty>Chưa có dữ liệu trong khoảng này.</Empty> : (
          <div className="tw">
            <table>
              <thead><tr><th>Định dạng</th><th className="num">Thành công</th><th className="num">Thất bại</th><th className="num">Chưa rõ</th><th className="num">Đang chạy</th><th className="num">Hủy</th><th className="num">Tỷ lệ thành công</th></tr></thead>
              <tbody>
                {formats.map((ct) => {
                  const ok = n(ct, OK);
                  const fail = n(ct, ['FAILED_CONFIRMED']);
                  const unk = n(ct, UNRESOLVED);
                  return (
                    <tr key={ct}>
                      <td>{label(ct)}</td>
                      <td className="num">{ok}</td>
                      <td className="num">{fail}</td>
                      <td className="num">{unk}</td>
                      <td className="num">{n(ct, INFLIGHT)}</td>
                      <td className="num">{n(ct, ['CANCELLED'])}</td>
                      <td className="num"><strong>{pct(ok, ok + fail + unk)}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="card">
        <summary>Lần thử và chi phí</summary>
        {r.attempts.length === 0 ? <Empty>Chưa có.</Empty> : (
          <div className="chips">{r.attempts.map((a) => <span key={a.outcome} className="badge muted">{a.outcome}: {a._count}</span>)}</div>
        )}
        <p className="muted">{r.automatic} bài tự xác minh · {r.operatorConfirmed} bài người dùng xác nhận · ${r.llmUsd.toFixed(2)} chi phí LLM</p>
        {r.llmUsdPerSuccess !== null && <p className="muted">${r.llmUsdPerSuccess.toFixed(3)} cho mỗi bài đăng thành công</p>}
      </details>
    </>
  );
}
