import Link from 'next/link';
import { ActionButton, AutoRefresh } from '@/components/client';
import { Badge, Empty, Head, Kpi } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ago, fmtTime, reasonText } from '@/lib/format';
import type { PublicationPlan } from './schedule/PublicationPlans';

interface DashboardData {
  at: string;
  sources: Array<{ code: string; enabled: boolean; lastSuccessAt: string | null; stale: boolean; lastError: string | null; paused: boolean }>;
  targets: Array<{ code: string; enabled: boolean; ready: number; paused: string | null }>;
  publications24hByFormat: Record<string, { verified: number; operatorConfirmed: number }>;
  openTasks: Record<string, number>;
  killSwitches: Array<{ scope: string; reason: string | null }>;
  workers: Array<{ name: string; kind: string; lastHeartbeatAt: string | null }>;
}

export default async function Dashboard() {
  const s = await getSession();
  const [data, plans] = await Promise.all([
    apiGet<DashboardData>('/dashboard', s.token),
    apiGet<PublicationPlan[]>('/publication-schedules', s.token),
  ]);
  const operate = can.operate(s.role);
  const now = +new Date(data.at);
  const active = plans.filter(plan => plan.status === 'RUNNING' || plan.status === 'SCHEDULED');
  const reviews = data.openTasks.REVIEW_CONTENT ?? 0;
  const interventions = (data.openTasks.TAKEOVER_ACCOUNT ?? 0) + (data.openTasks.CONFIRM_RESULT ?? 0);
  const posted = Object.values(data.publications24hByFormat).reduce((sum, row) => sum + row.verified + row.operatorConfirmed, 0);
  const globalPause = data.killSwitches.find(control => control.scope === 'GLOBAL');
  const stale = (last: string | null) => !last || now - +new Date(last) > 120_000;
  return <>
    <AutoRefresh seconds={active.length ? 5 : 15} />
    <Head title="Tổng quan" right={<Link href="/schedule">Mở lịch đăng</Link>} />
    {globalPause && <div className="alerts"><div className="alert bad" role="status">
      <Link href="/controls">Toàn hệ thống đang tạm dừng</Link>{globalPause.reason && ` · ${globalPause.reason}`}
    </div></div>}
    <div className="grid">
      <Link href="/schedule"><Kpi value={active.length} label="Lịch đang chạy hoặc sắp chạy" /></Link>
      <Link href="/review"><Kpi value={reviews} label="Bài chờ duyệt" kind={reviews ? 'warn' : undefined} /></Link>
      <Link href="/tasks"><Kpi value={interventions} label="Việc cần xử lý" kind={interventions ? 'warn' : undefined} /></Link>
      <Link href="/reports?days=1"><Kpi value={posted} label="Đã đăng trong 24 giờ" kind="ok" /></Link>
    </div>

    <section className="card">
      <h2>Lịch đang chạy và sắp chạy</h2>
      {active.length ? <div className="tw"><table>
        <thead><tr><th>Luồng</th><th>Trạng thái</th><th>Tiến độ</th><th>Tiếp theo</th><th>Thao tác</th></tr></thead>
        <tbody>{active.map(plan => <tr key={plan.id}>
          <td><strong>{plan.sourceCodes.join(', ')} → {plan.targetCodes.join(', ')}</strong></td>
          <td><Badge s={plan.status === 'RUNNING' ? 'STARTED' : 'PLANNED'} />{plan.reason && <div className="muted">{reasonText(plan.reason)}</div>}</td>
          <td>{plan.posted} đã đăng · {plan.active} đang xử lý · {plan.waiting} chờ</td>
          <td>{fmtTime(plan.nextAt ?? plan.startsAt)}</td>
          <td><div className="actions">
            <Link href={{ pathname: '/schedule', query: { view: 'history', schedule: plan.id } }}>Xem lượt</Link>
            {operate && <ActionButton path={`publication-schedules/${plan.id}/stop`} className="sm danger"
              confirm="Dừng những lượt còn chờ trong lịch này?">Dừng lịch</ActionButton>}
          </div></td>
        </tr>)}</tbody>
      </table></div> : <Empty>Chưa có lịch đăng đang hoạt động.</Empty>}
    </section>

    <div className="two">
      <section className="card">
        <h2>Nguồn quét</h2>
        <div className="tw"><table>
          <thead><tr><th>Hồ sơ</th><th>Lần đọc cuối</th><th>Trạng thái</th></tr></thead>
          <tbody>{data.sources.map(source => <tr key={source.code}>
            <td><Link href={{ pathname: '/library', query: { profile: source.code } }}>{source.code}</Link></td>
            <td>{fmtTime(source.lastSuccessAt)}</td>
            <td><Badge s={!source.enabled ? 'CANCELLED' : source.paused ? 'DEFERRED' : source.stale ? 'MISSED' : 'DONE'}
              text={!source.enabled ? 'Đã tắt' : source.paused ? 'Tạm dừng' : source.stale ? 'Chậm hoặc lỗi' : 'Đọc tốt'} />
              {source.enabled && source.stale && source.lastError && <div className="muted">{source.lastError}</div>}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
      <section className="card">
        <h2>Tài khoản đích</h2>
        <div className="tw"><table>
          <thead><tr><th>Hồ sơ</th><th className="num">Bài sẵn sàng</th><th>Trạng thái</th></tr></thead>
          <tbody>{data.targets.map(target => <tr key={target.code}>
            <td><Link href={{ pathname: '/library', query: { profile: target.code } }}>{target.code}</Link></td>
            <td className="num">{target.ready}</td>
            <td><Badge s={!target.enabled ? 'CANCELLED' : target.paused !== null ? 'NEEDS_OPERATOR' : 'DONE'}
              text={!target.enabled ? 'Đã tắt' : target.paused !== null ? 'Tạm dừng' : 'Sẵn sàng'} />
              {target.paused && <div className="muted">{reasonText(target.paused)}</div>}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </div>

    <details className="card" open={data.workers.some(worker => stale(worker.lastHeartbeatAt)) || undefined}>
      <summary>Worker và công tắc dừng</summary>
      <div className="tw"><table>
        <thead><tr><th>Worker</th><th>Loại</th><th>Tín hiệu gần nhất</th></tr></thead>
        <tbody>{data.workers.map(worker => <tr key={worker.name}>
          <td className="mono">{worker.name}</td><td>{worker.kind}</td>
          <td>{ago(worker.lastHeartbeatAt, now)} {stale(worker.lastHeartbeatAt) && <Badge s="MISSED" text="Mất tín hiệu" />}</td>
        </tr>)}</tbody>
      </table></div>
      <p><Link href="/controls">Mở công tắc dừng</Link></p>
    </details>
  </>;
}
