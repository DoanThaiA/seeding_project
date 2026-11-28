'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { MappingForm, Panel, SourceForm, TargetForm, sourceMethods, sourceStatus, type MappingT, type SourceT, type TargetT } from './SettingsForms';
import styles from './settings.module.css';

const views = { flows: 'Luồng A → B', sources: 'Nguồn quét', targets: 'Tài khoản đích' };
type View = keyof typeof views;

export function SettingsWorkspace({ sources, targets, mappings }: {
  sources: SourceT[]; targets: TargetT[]; mappings: MappingT[];
}) {
  const [view, setView] = useState<View>('flows');
  const bySource = new Map(sources.map(s => [s.id, s]));
  const byTarget = new Map(targets.map(t => [t.id, t]));
  const viewsOfFlow = mappings.flatMap(m => {
    const source = bySource.get(m.sourceId);
    const target = byTarget.get(m.targetId);
    return source && target ? [{ mapping: m, source, target, name: source.code + ' → ' + target.code }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  const [flowId, setFlowId] = useState(viewsOfFlow[0]?.mapping.id ?? 'new');
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? 'new');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? 'new');
  const activeFlow = viewsOfFlow.find(f => f.mapping.id === flowId);

  return <div className={styles.workspace}>
    <AutoRefresh seconds={15} />
    <header className={styles.heading}>
      <div>
        <h1>Quản trị luồng đăng</h1>
        <p>Thiết lập nguồn Facebook, tài khoản đích và cách duyệt bài.</p>
      </div>
      <Link className={styles.secondaryAction} href="/schedule">Mở lịch đăng</Link>
    </header>
    <nav className={styles.tabs} aria-label="Mục quản trị">
      {(Object.entries(views) as Array<[View, string]>).map(([key, title]) =>
        <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>{title}</button>)}
    </nav>
    {view === 'flows' && <>
      <div className={styles.workArea}>
        <aside className={styles.flowList} aria-label="Danh sách luồng">
          <div className={styles.listHeading}><h2>Luồng đang cấu hình</h2><span>{viewsOfFlow.length}</span></div>
          <div className={styles.flowItems}>
            {viewsOfFlow.map(f => {
              const enabled = f.mapping.enabled && f.source.enabled && f.target.enabled;
              const status = sourceStatus(f.source);
              return <button className={styles.flowItem} key={f.mapping.id} aria-pressed={f.mapping.id === flowId} onClick={() => setFlowId(f.mapping.id)} type="button">
                <span><strong>{f.name}</strong><small>{sourceMethods[f.source.connector] ?? f.source.connector}</small></span>
                <Badge s={!enabled ? 'CANCELLED' : status.tone === 'MISSED' ? 'MISSED' : 'DONE'} text={!enabled ? 'Đã tắt' : status.tone === 'MISSED' ? 'Lỗi quét' : 'Đang bật'} />
              </button>;
            })}
          </div>
          <button className={styles.addFlow} aria-pressed={flowId === 'new'} type="button" onClick={() => setFlowId('new')}>+ Tạo luồng</button>
        </aside>
        <div className={styles.flowMain}>
          {activeFlow ? <>
            <div className={styles.flowTitle}>
              <div><h2>{activeFlow.name}</h2><p>{activeFlow.source.name} <span aria-hidden>→</span> {activeFlow.target.name}</p></div>
              {activeFlow.mapping.enabled && <Link href={{ pathname: '/profile-sync', query: { source: activeFlow.source.code,
                target: activeFlow.target.code } }}>Đồng bộ hồ sơ</Link>}
            </div>
            <div className={styles.cards}>
              <SourceForm key={activeFlow.source.id} source={activeFlow.source} />
              <TargetForm key={activeFlow.target.id} target={activeFlow.target} />
            </div>
            <MappingForm key={activeFlow.mapping.id} {...{ sources, targets, mappings }} mapping={activeFlow.mapping} onCreated={setFlowId} />
            {(mappings.filter(m => m.sourceId === activeFlow.source.id).length > 1 || mappings.filter(m => m.targetId === activeFlow.target.id).length > 1)
              && <p className={styles.hint}>Các luồng dùng chung nguồn hoặc đích sẽ dùng chung cấu hình của nguồn hoặc đích đó.</p>}
          </> : flowId === 'new' ? <>
            {(!sources.length || !targets.length) && <Panel title="Chuẩn bị nguồn và đích">
              <p className="muted">Tạo nguồn và tài khoản đích trước khi ghép thành luồng.</p>
              <div className="actions">
                {!sources.length && <button type="button" onClick={() => { setSourceId('new'); setView('sources'); }}>Thêm nguồn</button>}
                {!targets.length && <button type="button" onClick={() => { setTargetId('new'); setView('targets'); }}>Thêm đích</button>}
              </div>
            </Panel>}
            <MappingForm {...{ sources, targets, mappings }} onCreated={setFlowId} />
          </> : <Empty>Đang tải luồng vừa tạo…</Empty>}
        </div>
      </div>
    </>}
    {view === 'sources' && <div className={styles.resource}>
      <div className={styles.resourcePicker}><label htmlFor="admin-source">Nguồn quét</label><select id="admin-source" value={sourceId} onChange={e => setSourceId(e.target.value)}>
        {sources.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}<option value="new">+ Thêm nguồn</option>
      </select></div>
      <SourceForm key={sourceId} source={bySource.get(sourceId)} />
    </div>}
    {view === 'targets' && <div className={styles.resource}>
      <div className={styles.resourcePicker}><label htmlFor="admin-target">Tài khoản đích</label><select id="admin-target" value={targetId} onChange={e => setTargetId(e.target.value)}>
        {targets.map(t => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}<option value="new">+ Thêm đích</option>
      </select></div>
      <TargetForm onCreated={setTargetId} key={byTarget.get(targetId)?.id ?? 'new'} target={byTarget.get(targetId)} />
    </div>}
  </div>;
}
