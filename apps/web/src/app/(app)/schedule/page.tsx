import Link from 'next/link';
import { ActionButton, AutoRefresh } from '@/components/client';
import { Badge, Empty, Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { fmtTime, label, reasonText } from '@/lib/format';
import { BacklogCaption } from './BacklogCaption';

interface Slot {
  id: string;
  slotAt: string;
  manual: boolean;
  status: string;
  reason: string | null;
  publicationId: string | null;
  target: { code: string };
}
interface BacklogItem {
  id: string;
  target: string;
  source: string;
  contentType: string;
  readyAt: string;
  expiresAt: string | null;
  preview: string | null;
  caption: string | null;
  snapshotHash: string | null;
  targetAudience: string;
  blockReason: string | null;
  blockedText: string | null;
}

export default async function Schedule({ searchParams }: { searchParams: Promise<{ hours?: string }> }) {
  const { hours = '24' } = await searchParams;
  const h = ['12', '24', '72'].includes(hours) ? hours : '24';
  const session = await getSession();
  const canPublish = can.operate(session.role);
  const [slots, backlog, targets] = await Promise.all([apiGet<Slot[]>(`/slots?hours=${h}`, session.token), apiGet<BacklogItem[]>('/backlog', session.token), apiGet<Array<{ code: string }>>('/targets', session.token)]);
  const codes = targets.map((t) => t.code);
  const rows = [...new Set(slots.map((s) => s.slotAt))].sort().reverse();
  const cell = (at: string, code: string) => slots.find((s) => s.slotAt === at && s.target.code === code);
  const byTarget: Record<string, BacklogItem[]> = {};
  for (const b of backlog) (byTarget[b.target] ??= []).push(b);
  return (
    <>
      <AutoRefresh seconds={30} />
      <Head title="Lịch &amp; backlog" sub="Lịch tự động chọn bài sẵn sàng đầu giờ. Dùng Đăng ngay để gửi một bài cụ thể cho worker." right={<a href="#backlog">Đến Backlog ({backlog.length}) ↓</a>} />

      <div className="filters">
        {['12', '24', '72'].map((x) => <Link key={x} href={`/schedule?hours=${x}`} aria-current={h === x}>{x} giờ qua</Link>)}
      </div>

      <section className="card">
        <h2>Các lượt đăng (giờ Việt Nam)</h2>
        {rows.length === 0 ? <Empty>Chưa có lượt nào.</Empty> : (
          <div className="tw">
            <table>
              <thead><tr><th>Giờ</th>{codes.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((at) => (
                  <tr key={at}>
                    <td><strong>{fmtTime(at)}</strong>{slots.some(s => s.slotAt === at && s.manual) && <div className="muted">Thủ công</div>}</td>
                    {codes.map((c) => {
                      const s = cell(at, c);
                      return (
                        <td key={c} title={s?.reason ? reasonText(s.reason) : undefined}>
                          {s ? (s.publicationId ? <Link href={`/publications/${s.publicationId}`}><Badge s={s.status} /></Link> : <Badge s={s.status} />) : <span className="muted">—</span>}
                          {s?.reason && s.status === 'DEFERRED' && <div className="muted" style={{ fontSize: 12 }}>{reasonText(s.reason)}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="backlog" className="card">
        <h2>Backlog ({backlog.length} bài)</h2>
        {backlog.length === 0 ? <Empty>Không có bài nào đang chờ lượt.</Empty> : (
          Object.entries(byTarget).map(([t, items]) => (
            <div key={t} style={{ marginBottom: 14 }}>
              <strong>{t}</strong> <span className="muted">· {items.length} bài</span>
              <div className="tw">
                <table>
                  <tbody>
                    {items.map((b, i) => (
                      <tr key={b.id}>
                        <td className="num" style={{ width: 28 }}>{i + 1}</td>
                        <td style={{ width: 60 }}>{b.source}</td>
                        <td style={{ width: 110 }}>{label(b.contentType)}</td>
                        <td>{b.preview}{can.review(session.role) && b.snapshotHash && <BacklogCaption key={b.snapshotHash} id={b.id} value={b.caption ?? ''} snapshotHash={b.snapshotHash} optional={b.contentType === 'REEL'}
                          audience={b.blockReason === 'AUDIENCE_CONFIG_CHANGED' ? b.targetAudience : undefined} />}</td>
                        <td style={{ whiteSpace: 'nowrap' }} className="muted">hết hạn {fmtTime(b.expiresAt)}</td>
                        {canPublish && <td>{b.blockedText
                          ? <span className="muted">{b.blockedText}</span>
                          : <ActionButton className="sm primary" path={`backlog/${b.id}/publish`} confirm={`Gửi bài đã chọn để đăng ngay lên ${b.target}?`}>Đăng ngay</ActionButton>}
                        </td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}
