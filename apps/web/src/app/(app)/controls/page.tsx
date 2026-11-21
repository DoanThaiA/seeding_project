import { AutoRefresh } from '@/components/client';
import { Badge, Empty, Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { fmtTime, reasonText } from '@/lib/format';
import { ControlForm, ResumeButton } from './ControlForm';

interface Control {
  id: string;
  scope: 'GLOBAL' | 'SOURCE' | 'TARGET' | 'FORMAT' | 'CONNECTOR';
  scopeKey: string;
  paused: boolean;
  reason: string | null;
  setBy: string;
  updatedAt: string;
}

const SCOPE_VI = { GLOBAL: 'Toàn hệ thống', SOURCE: 'Nguồn', TARGET: 'Tài khoản đích', FORMAT: 'Định dạng', CONNECTOR: 'Connector' } as const;

export default async function Controls() {
  const s = await getSession();
  const [controls, sources, targets] = await Promise.all([
    apiGet<Control[]>('/controls', s.token),
    apiGet<Array<{ id: string; code: string; connector: string }>>('/sources', s.token),
    apiGet<Array<{ id: string; code: string; connector: string }>>('/targets', s.token),
  ]);
  const name = (c: Control) => {
    if (c.scope === 'SOURCE') return sources.find((x) => x.id === c.scopeKey)?.code ?? c.scopeKey;
    if (c.scope === 'TARGET') return targets.find((x) => x.id === c.scopeKey)?.code ?? c.scopeKey;
    return c.scopeKey === '*' ? '—' : c.scopeKey;
  };
  const active = controls.filter((c) => c.paused);
  const options = {
    SOURCE: sources.map((x) => ({ value: x.id, label: x.code })),
    TARGET: targets.map((x) => ({ value: x.id, label: x.code })),
    FORMAT: ['TEXT', 'QUOTE_IMAGE', 'SINGLE_PHOTO', 'MULTI_PHOTO', 'NAMED_ALBUM', 'VIDEO', 'REEL'].map((v) => ({ value: v, label: v })),
    CONNECTOR: [...new Set(['fake', 'fb-web', ...sources.map((s) => s.connector), ...targets.map((t) => t.connector)])].map((v) => ({ value: v, label: v })),
  };
  const operate = can.operate(s.role);
  return (
    <>
      <AutoRefresh seconds={20} />
      <Head title="Công tắc dừng" sub="Dừng việc mới theo phạm vi. Việc đã bấm đăng vẫn được xác minh bình thường; chỉ việc chưa bắt đầu bị chặn." />
      <section className="card">
        <h2>Đang bật ({active.length})</h2>
        {active.length === 0 ? <Empty>Không có công tắc dừng nào.</Empty> : (
          <div className="tw">
            <table>
              <thead><tr><th>Phạm vi</th><th>Đối tượng</th><th>Lý do</th><th>Bởi</th><th>Lúc</th><th></th></tr></thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.id}>
                    <td><Badge s="NEEDS_OPERATOR" text={SCOPE_VI[c.scope]} /></td>
                    <td><strong>{name(c)}</strong></td>
                    <td>{c.reason ? reasonText(c.reason) : ''}</td>
                    <td className="mono muted">{c.setBy}</td>
                    <td>{fmtTime(c.updatedAt)}</td>
                    <td>{operate && <ResumeButton scope={c.scope} scopeKey={c.scopeKey} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {operate ? (
        <section className="card">
          <h2>Bật công tắc dừng</h2>
          <ControlForm options={options} />
        </section>
      ) : (
        <div className="alert warn">Bạn chỉ có quyền xem.</div>
      )}
    </>
  );
}
