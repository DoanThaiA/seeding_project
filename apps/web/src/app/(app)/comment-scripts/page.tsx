import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { apiGet, can, getSession } from '@/lib/api';
import type { ProfileDirectory } from '../profile-groups/ProfileGroups';
import { ScriptEditor, ScriptRun, type Script, type ScriptSummary } from './CommentScripts';

export default async function CommentScriptsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  const [query, scripts, directory] = await Promise.all([searchParams, apiGet<ScriptSummary[]>('/comment-scripts', session.token),
    apiGet<ProfileDirectory>('/profile-groups', session.token)]);
  const canEdit = can.operate(session.role);
  const selected = query.new === '1' && canEdit ? undefined : scripts.find(script => script.id === query.id) ?? scripts[0];
  const script = selected ? await apiGet<Script>(`/comment-scripts/${selected.id}`, session.token) : undefined;
  const active = scripts.some(item => item.steps.some(step => ['QUEUED', 'SENDING'].includes(step.status)));
  const targets = directory.targets.map(({ id, code, name, canComment }) => ({ id, code, name, canComment }));
  return <div className="workflow-stack">
    {active && <AutoRefresh seconds={4} />}
    <header className="workflow-toolbar"><h1>Kịch bản bình luận</h1>
      {canEdit && <Link className="btn" href="/comment-scripts?new=1">Tạo kịch bản</Link>}
    </header>
    <div className="workflow-layout">
      <nav className="card workflow-stack workflow-nav" aria-label="Kịch bản đã lưu">
        <h2>Kịch bản đã lưu</h2>
        {scripts.map(item => <Link href={{ pathname: '/comment-scripts', query: { id: item.id } }}
          key={item.id} aria-current={item.id === script?.id ? 'page' : undefined}>
          <strong>{item.name}</strong><small>{item.startedAt ? `${item.steps.filter(step => step.status === 'POSTED').length}/${item.steps.length} đã gửi` : 'Bản nháp'}</small>
        </Link>)}
        {!scripts.length && <p className="muted">Chưa lưu kịch bản.</p>}
      </nav>
      {canEdit && !script?.startedAt ? <ScriptEditor key={script ? `${script.id}:${script.version}` : 'new'} script={script}
        groups={directory.groups} targets={targets} /> : script ? <ScriptRun script={script} canOperate={canEdit} /> : null}
    </div>
  </div>;
}
