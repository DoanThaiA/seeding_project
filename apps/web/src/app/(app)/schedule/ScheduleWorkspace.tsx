'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ActionButton } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { fmtTime, label, reasonText } from '@/lib/format';
import { BacklogCaption } from './BacklogCaption';
import { PlanComposer, PublicationPlans, type PlanSource, type PublicationPlan } from './PublicationPlans';
import styles from './schedule.module.css';

export interface Slot {
  id: string;
  slotAt: string;
  manual: boolean;
  status: string;
  reason: string | null;
  scheduleId: string | null;
  sourceCode: string | null;
  sourceCodes: string[];
  publication: { id: string; status: string; variantId: string; permalink: string | null; lastReason: string | null } | null;
  target: { code: string };
}

const slotState = (slot: Slot) => slot.reason === 'SCHEDULE_STOPPED' || slot.publication?.lastReason === 'SCHEDULE_STOPPED'
  ? 'STOPPED' : slot.publication?.status ?? slot.status;

export interface BacklogItem {
  id: string;
  target: string;
  source: string;
  contentType: string;
  expiresAt: string | null;
  preview: string | null;
  caption: string | null;
  snapshotHash: string | null;
  targetAudience: string;
  blockReason: string | null;
  blockedText: string | null;
}

type View = 'plans' | 'backlog' | 'history';
const PAGE_SIZE = 25;
const defaults = { source: '', target: '', format: '', status: '', query: '' };
const sortedOptions = (values: string[]) =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
const searchable = (text: string) =>
  text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

function Filter({ title, value, options, onChange }: {
  title: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return <div className={styles.filter}>
    <label htmlFor={id}>{title}</label>
    <select id={id} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Tất cả</option>
      {options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </div>;
}

function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return <div className={styles.pagination}>
    <span>Trang {page + 1}/{pages}</span>
    <button className="sm" type="button" disabled={page === 0} onClick={() => onChange(page - 1)}>Trước</button>
    <button className="sm" type="button" disabled={page === pages - 1} onClick={() => onChange(page + 1)}>Sau</button>
  </div>;
}

function SelectAll({ checked, partial, disabled, onChange }: {
  checked: boolean; partial: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return <input className={styles.checkbox} ref={ref} type="checkbox" aria-label="Chọn tất cả bài sẵn sàng trong kết quả lọc"
    checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}

function Backlog({ items, targets, canPublish, canReview, onPlanCreated }: {
  items: BacklogItem[]; targets: string[]; canPublish: boolean; canReview: boolean; onPlanCreated: () => void;
}) {
  const [filters, setFilters] = useState(defaults);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const update = (next: typeof defaults) => {
    setFilters(next);
    setPage(0);
    setPicked(new Set());
  };
  const query = searchable(filters.query.trim());
  const visible = items.filter(item =>
    (!filters.source || item.source === filters.source)
    && (!filters.target || item.target === filters.target)
    && (!filters.format || item.contentType === filters.format)
    && (!filters.status || (filters.status === 'ready' ? !item.blockReason : !!item.blockReason))
    && (!query || searchable(item.caption ?? item.preview ?? '').includes(query)),
  );
  const eligible = visible.filter(item => !item.blockReason);
  const selected = eligible.filter(item => picked.has(item.id));
  const counts = new Map<string, number>();
  for (const item of selected) counts.set(item.target, (counts.get(item.target) ?? 0) + 1);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const activePage = Math.min(page, pages - 1);

  return <section className="card" id="backlog">
    <div className={styles.filters}>
      <label className={styles.search}>Tìm theo caption
        <input type="search" placeholder="Nhập từ khóa…" value={filters.query}
          onChange={event => update({ ...filters, query: event.target.value })} />
      </label>
      <Filter title="Nguồn" value={filters.source} options={sortedOptions(items.map(item => item.source)).map(code => [code, code])}
        onChange={source => update({ ...filters, source })} />
      <Filter title="Đích" value={filters.target} options={targets.map(code => [code, code])}
        onChange={target => update({ ...filters, target })} />
      <Filter title="Định dạng" value={filters.format} options={sortedOptions(items.map(item => item.contentType)).map(type => [type, label(type)])}
        onChange={format => update({ ...filters, format })} />
      <Filter title="Trạng thái" value={filters.status} options={[['ready', 'Sẵn sàng'], ['blocked', 'Cần xử lý']]}
        onChange={status => update({ ...filters, status })} />
      <button type="button" onClick={() => update(defaults)} disabled={Object.values(filters).every(value => !value)}>Xóa bộ lọc</button>
    </div>
    <div className={styles.selectionBar}>
      <div className={styles.summary}>
        <strong>{visible.length} bài</strong>
        <span>{eligible.length} sẵn sàng</span>
        <span>{visible.length - eligible.length} cần xử lý</span>
      </div>
      {canPublish && <div className={styles.selectionActions}>
        <button type="button" className="sm" disabled={!eligible.length}
          onClick={() => setPicked(new Set(eligible.map(item => item.id)))}>Chọn tất cả ({eligible.length})</button>
        <button type="button" className="sm" disabled={!selected.length} onClick={() => setPicked(new Set())}>Bỏ chọn</button>
      </div>}
    </div>
    {canPublish && selected.length > 0 && <div className={styles.batch}>
      <div className={styles.batchTitle}><strong>Đã chọn {selected.length} bài</strong><span>{counts.size} tài khoản đích</span></div>
      <PlanComposer selection={{ variantIds: selected.map(item => item.id) }} maxPerTarget={Math.max(...counts.values())}
        onCreated={() => { setPicked(new Set()); onPlanCreated(); }} />
    </div>}
    {visible.length === 0 ? <Empty>{items.length ? 'Không tìm thấy bài phù hợp.' : 'Không có bài nào đang chờ lượt.'}</Empty> :
      <div className="tw">
        <table className={styles.backlogTable}>
          <thead><tr>
            {canPublish && <th scope="col"><SelectAll checked={eligible.length > 0 && selected.length === eligible.length}
              partial={selected.length > 0 && selected.length < eligible.length} disabled={!eligible.length}
              onChange={checked => setPicked(new Set(checked ? eligible.map(item => item.id) : []))} /></th>}
            <th scope="col">Luồng</th><th scope="col">Định dạng</th><th scope="col">Nội dung</th>
            <th scope="col">Hết hạn</th><th scope="col">Trạng thái</th>{canPublish && <th scope="col">Thao tác</th>}
          </tr></thead>
          <tbody>{visible.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map(item => {
            const checked = !item.blockReason && picked.has(item.id);
            return <tr key={item.id} data-selected={checked}>
              {canPublish && <td><input type="checkbox" className={styles.checkbox} checked={checked} disabled={!!item.blockReason}
                aria-label={`Chọn bài ${item.source} đến ${item.target}: ${item.preview || label(item.contentType)}`}
                onChange={event => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(item.id); else next.delete(item.id);
                  setPicked(next);
                }} /></td>}
              <td className={styles.nowrap}><strong>{item.source} → {item.target}</strong></td>
              <td className={styles.nowrap}>{label(item.contentType)}</td>
              <td className={styles.caption}>
                {item.preview || <span className="muted">Không có caption</span>}
                {canReview && item.snapshotHash && <BacklogCaption key={item.snapshotHash} id={item.id} value={item.caption ?? ''}
                  snapshotHash={item.snapshotHash} optional={item.contentType === 'REEL'}
                  audience={item.blockReason === 'AUDIENCE_CONFIG_CHANGED' ? item.targetAudience : undefined} />}
              </td>
              <td className={styles.nowrap}>{fmtTime(item.expiresAt)}</td>
              <td><Badge s={item.blockReason ? 'NEEDS_REVIEW' : 'READY'} text={item.blockReason ? 'Cần xử lý' : 'Sẵn sàng'} />
                {item.blockedText && <div className={styles.reason}>{item.blockedText}</div>}</td>
              {canPublish && <td className={styles.nowrap}>{!item.blockReason && <ActionButton className="sm" path={`backlog/${item.id}/publish`}
                confirm={`Gửi bài đã chọn để đăng ngay lên ${item.target}?`}>Đăng ngay</ActionButton>}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>}
    <Pagination page={activePage} pages={pages} onChange={setPage} />
  </section>;
}

function History({ slots, targets, range, scheduleId }: { slots: Slot[]; targets: string[]; range: string; scheduleId?: string }) {
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const visible = slots.filter(slot => (!target || slot.target.code === target) && (!status || slotState(slot) === status)
    && (!kind || (slot.scheduleId ? kind === 'plan' : slot.manual ? kind === 'manual' : kind === 'automatic')));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const activePage = Math.min(page, pages - 1);
  return <section className="card">
    <div className={styles.historyHeader}>
      <div><h2>{scheduleId ? 'Các lượt trong lịch đã chọn' : 'Nhật ký đăng'}</h2><span className="muted">Giờ Việt Nam</span></div>
      <nav className={styles.ranges} aria-label="Khoảng thời gian">
        {scheduleId ? <Link href="/schedule?view=history">Xem toàn bộ nhật ký</Link>
          : ['12', '24', '72'].map(hours => <Link key={hours} href={`/schedule?view=history&hours=${hours}`}
            scroll={false} aria-current={range === hours} onClick={() => setPage(0)}>{hours} giờ qua</Link>)}
      </nav>
    </div>
    <div className={styles.filters}>
      <Filter title="Đích" value={target} options={targets.map(code => [code, code])}
        onChange={value => { setTarget(value); setPage(0); }} />
      <Filter title="Trạng thái" value={status} options={sortedOptions(slots.map(slotState)).map(value => [value, label(value)])}
        onChange={value => { setStatus(value); setPage(0); }} />
      <Filter title="Cách chạy" value={kind} options={[['plan', 'Lịch đã tạo'], ['automatic', 'Lịch cũ'], ['manual', 'Đăng ngay']]}
        onChange={value => { setKind(value); setPage(0); }} />
      <button type="button" onClick={() => { setTarget(''); setStatus(''); setKind(''); setPage(0); }}
        disabled={!target && !status && !kind}>Xóa bộ lọc</button>
    </div>
    <p className={styles.historyCount}>{visible.length} lượt{slots.length === 500 ? ' · Tối đa 500 lượt gần nhất' : ''}</p>
    {!visible.length ? <Empty>Không có lượt đăng phù hợp.</Empty> : <div className="tw">
      <table>
        <thead><tr><th scope="col">Thời gian</th><th scope="col">Luồng</th><th scope="col">Cách chạy</th><th scope="col">Trạng thái</th><th scope="col">Chi tiết</th></tr></thead>
        <tbody>{visible.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map(slot => {
          const source = slot.sourceCode || slot.sourceCodes.join(', ');
          const reason = slot.publication?.lastReason || slot.reason;
          return <tr key={slot.id}>
            <td className={styles.nowrap}>{fmtTime(slot.slotAt)}</td>
            <td><strong>{source ? `${source} → ${slot.target.code}` : slot.target.code}</strong></td>
            <td>{slot.scheduleId ? 'Lịch đã tạo' : slot.manual ? 'Đăng ngay' : 'Lịch cũ'}</td>
            <td><Badge s={slotState(slot)} /></td>
            <td>{reason && <div className={styles.reason}>{reasonText(reason)}</div>}
              {slot.publication && <Link href={`/publications/${slot.publication.id}`}>Xem lượt đăng</Link>}
              {slot.publication?.permalink && <> · <a href={slot.publication.permalink} target="_blank" rel="noreferrer">Mở bài Facebook</a></>}
              {!reason && !slot.publication && <span className="muted">—</span>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <Pagination page={activePage} pages={pages} onChange={setPage} />
  </section>;
}

export function ScheduleWorkspace({ backlog, slots, targets, sources, plans, range, scheduleId, initialView, canPublish, canReview }: {
  backlog: BacklogItem[]; slots: Slot[]; targets: string[]; range: string; initialView: View;
  sources: PlanSource[]; plans: PublicationPlan[]; scheduleId?: string; canPublish: boolean; canReview: boolean;
}) {
  const [view, setView] = useState<View>(initialView);
  return <>
    <nav className={styles.tabs} aria-label="Mục lịch và bài chờ">
      <button type="button" aria-pressed={view === 'plans'} onClick={() => setView('plans')}>Lịch đăng</button>
      <button type="button" aria-pressed={view === 'backlog'} onClick={() => setView('backlog')}>Bài chờ <span>{backlog.length}</span></button>
      <button type="button" aria-pressed={view === 'history'} onClick={() => setView('history')}>Nhật ký</button>
    </nav>
    <div hidden={view !== 'plans'}><PublicationPlans {...{ plans, sources }} canManage={canPublish} /></div>
    <div hidden={view !== 'backlog'}><Backlog items={backlog} {...{ targets, canPublish, canReview }} onPlanCreated={() => setView('plans')} /></div>
    <div hidden={view !== 'history'}><History {...{ slots, targets, range, scheduleId }} /></div>
  </>;
}
