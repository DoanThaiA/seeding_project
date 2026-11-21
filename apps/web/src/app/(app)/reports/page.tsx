import Link from 'next/link';
import { Empty, Head, Kpi } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { fmtTime, label, pct } from '@/lib/format';

interface Report {
  since: string;
  publications: Array<{ contentType: string; status: string; _count: number }>;
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
      <Head title="Báo cáo" sub={`Từ ${fmtTime(r.since)} đến nay. Tỷ lệ thành công tính riêng từng định dạng; “chưa rõ” không tính là thành công.`} />
      <div className="filters">
        {[['1', '24 giờ'], ['7', '7 ngày'], ['30', '30 ngày']].map(([k, l]) => <Link key={k} href={`/reports?days=${k}`} aria-current={d === k}>{l}</Link>)}
      </div>
      <div className="grid">
        <Kpi value={total} label="Lượt đăng" />
        <Kpi value={r.automatic} label="Thành công tự động" kind="ok" />
        <Kpi value={r.operatorConfirmed} label="Người xác nhận" />
        <Kpi value={r.llmUsd ? `$${r.llmUsd.toFixed(2)}` : '$0'} label="Chi phí LLM" />
        <Kpi value={r.llmUsdPerSuccess === null ? '—' : `$${r.llmUsdPerSuccess.toFixed(3)}`} label="Chi phí LLM mỗi bài thành công" />
      </div>

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
            <p className="muted" style={{ marginBottom: 0 }}>Mục tiêu pilot: ≥95% bài thường, ≥90% nhiều ảnh/video. Cần ≥20 mẫu mỗi định dạng mới kết luận được.</p>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Các lần thực hiện (attempt)</h2>
        {r.attempts.length === 0 ? <Empty>Chưa có.</Empty> : (
          <div className="chips">{r.attempts.map((a) => <span key={a.outcome} className="badge muted">{a.outcome}: {a._count}</span>)}</div>
        )}
        {success > 0 && <p className="muted" style={{ marginBottom: 0 }}>Tự động hoàn tất {pct(r.automatic, success)} số bài thành công.</p>}
      </section>
    </>
  );
}
