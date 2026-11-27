'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { ActionButton, bff, useSubmit } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { fmtTime, reasonText } from '@/lib/format';
import styles from './schedule.module.css';

export interface PublicationPlan {
  id: string;
  startsAt: string;
  nextAt: string | null;
  intervalMinutes: number;
  limit: number;
  status: 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'STOPPED';
  sourceCodes: string[];
  targetCodes: string[];
  total: number;
  waiting: number;
  active: number;
  posted: number;
  failed: number;
  stopped: number;
  reason: string | null;
}

export type PlanSource = { id: string; code: string; name: string; enabled: boolean };
type PlanSelection = { sourceIds: string[] } | { variantIds: string[] };

export function PlanComposer({ selection, maxPerTarget = 1, onCreated }: {
  selection: PlanSelection; maxPerTarget?: number; onCreated: () => void;
}) {
  const id = useId();
  const [timing, setTiming] = useState<'later' | 'now'>('later');
  const [startsAt, setStartsAt] = useState('');
  const [interval, setInterval] = useState(5);
  const [limit, setLimit] = useState(10);
  const submit = useSubmit();
  const count = 'sourceIds' in selection ? selection.sourceIds.length : selection.variantIds.length;
  const tooMany = maxPerTarget > limit;
  return <form onSubmit={event => {
    event.preventDefault();
    const start = timing === 'later' ? new Date(startsAt + '+07:00') : null;
    if (start && !Number.isFinite(+start)) return;
    submit.run(async () => {
      const result = await bff('POST', 'publication-schedules', {
        ...selection, ...(start && { startsAt: start.toISOString() }), intervalMinutes: interval, limit,
      });
      if (result.ok) onCreated();
      return result;
    }, timing === 'now' ? 'Đã giao lịch cho worker.' : 'Đã lưu lịch đăng.');
  }}>
    <div className={styles.batchFields}>
      <label htmlFor={id + '-timing'}>Bắt đầu
        <select id={id + '-timing'} value={timing} onChange={event => setTiming(event.target.value === 'now' ? 'now' : 'later')}>
          <option value="later">Chọn ngày và giờ</option><option value="now">Chạy ngay</option>
        </select>
      </label>
      {timing === 'later' && <label htmlFor={id + '-start'}>Ngày và giờ Việt Nam
        <input id={id + '-start'} type="datetime-local" required value={startsAt} onChange={e => setStartsAt(e.target.value)} />
      </label>}
      <label htmlFor={id + '-interval'}>Cách nhau (phút)
        <input id={id + '-interval'} type="number" min={1} max={1440} required value={interval || ''}
          onChange={event => setInterval(Number(event.target.value))} />
      </label>
      <label htmlFor={id + '-limit'}>Tối đa mỗi đích
        <input id={id + '-limit'} type="number" min={1} max={50} required value={limit || ''}
          onChange={event => setLimit(Number(event.target.value))} />
      </label>
      <button type="submit" className="primary" disabled={submit.pending || !count || tooMany || count > 200}>
        {submit.pending ? 'Đang lưu…' : timing === 'now' ? 'Bắt đầu chạy' : 'Tạo lịch đăng'}
      </button>
    </div>
    {tooMany && <p className="err" role="status">Có đích đã chọn {maxPerTarget} bài. Tăng giới hạn hoặc bỏ chọn bớt.</p>}
    {count > 200 && <p className="err" role="status">Chọn tối đa 200 bài mỗi lịch.</p>}
    {submit.error && <p className="err" role="alert">{submit.error}</p>}
    {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
  </form>;
}

const planStatuses = {
  SCHEDULED: ['PLANNED', 'Đã lên lịch'], RUNNING: ['STARTED', 'Đang chạy'],
  COMPLETED: ['DONE', 'Đã kết thúc'], STOPPED: ['CANCELLED', 'Đã dừng'],
} as const;

export function PublicationPlans({ plans, sources, canManage }: { plans: PublicationPlan[]; sources: PlanSource[]; canManage: boolean }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [includeEnded, setIncludeEnded] = useState(false);
  const eligible = sources.map(source => source.id);
  const selected = chosen.filter(id => eligible.includes(id));
  const active = (p: PublicationPlan) => p.status === 'RUNNING' || p.status === 'SCHEDULED';
  const visible = plans.filter(plan => includeEnded || active(plan));
  return <>
    {canManage && <section className="card">
      <h2>Tạo lịch theo nguồn</h2>
      {sources.length ? <>
        <fieldset className={styles.sourcePicker}>
          <legend>Nguồn đăng</legend>
          <div className={styles.sourceChoices}>
            {sources.map(source => <label key={source.id} className={styles.sourceChoice} title={source.name}>
              <input type="checkbox" checked={selected.includes(source.id)} onChange={event => {
                const checked = event.target.checked;
                setChosen(previous => checked ? [...previous, source.id] : previous.filter(id => id !== source.id));
              }} /> <strong>{source.code}</strong> <span>{source.name}{!source.enabled && ' · Quét đang tắt'}</span>
            </label>)}
          </div>
          <div className={styles.selectionActions}>
            <button type="button" className="sm" onClick={() => setChosen(eligible)} disabled={selected.length === eligible.length}>Chọn tất cả</button>
            <button type="button" className="sm" onClick={() => setChosen([])} disabled={!selected.length}>Bỏ chọn</button>
            {selected.length > 0 && <span className="muted">Đã chọn {selected.length} nguồn</span>}
          </div>
        </fieldset>
        <PlanComposer selection={{ sourceIds: selected }} onCreated={() => setChosen([])} />
      </> : <Empty>Cần một luồng ghép nguồn với tài khoản đích đang bật.</Empty>}
    </section>}
    <section className="card">
      <div className={styles.historyHeader}>
        <h2>Lịch đang chạy và sắp chạy</h2>
        <label className={styles.inlineCheck}><input type="checkbox" checked={includeEnded} onChange={e => setIncludeEnded(e.target.checked)} /> Hiện lịch đã kết thúc</label>
      </div>
      {!visible.length ? <Empty>Chưa có lịch trong nhóm này.</Empty> : <div className="tw"><table className={styles.plansTable}>
        <thead><tr><th scope="col">Nguồn và đích</th><th scope="col">Thời gian</th><th scope="col">Tiến độ</th><th scope="col">Thao tác</th></tr></thead>
        <tbody>{visible.map(plan => {
          const [status, statusLabel] = planStatuses[plan.status];
          return <tr key={plan.id}>
            <td><strong>{plan.sourceCodes.join(', ')} → {plan.targetCodes.join(', ')}</strong></td>
            <td><div>{fmtTime(plan.startsAt)}</div><div className="muted">Mỗi {plan.intervalMinutes} phút</div>
              {plan.nextAt && active(plan) && <div className="muted">Tiếp theo {fmtTime(plan.nextAt)}</div>}</td>
            <td><Badge s={status} text={statusLabel} />
              <div className={styles.reason}>{plan.posted} đã đăng · {plan.active} đang xử lý · {plan.waiting} chờ</div>
              {(plan.failed > 0 || plan.stopped > 0) && <div className={styles.reason}>{plan.failed} cần xem · {plan.stopped} đã dừng</div>}
              {plan.reason && active(plan) && <div className={styles.reason}>{reasonText(plan.reason)}</div>}</td>
            <td><div className={styles.planActions}>
              <Link href={{ pathname: '/schedule', query: { view: 'history', schedule: plan.id } }}>Xem lượt</Link>
              {canManage && active(plan) && <ActionButton path={`publication-schedules/${plan.id}/stop`} className="sm danger"
                confirm="Dừng những lượt còn chờ trong lịch này? Worker vẫn xác minh bài đã gửi lên Facebook."
                onDone={() => setIncludeEnded(true)}>Dừng lịch</ActionButton>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>
  </>;
}
