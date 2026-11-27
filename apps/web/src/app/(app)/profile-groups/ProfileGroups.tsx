'use client';

import { useState } from 'react';
import type { SyncedProfileDetails } from '@seedingsys/contracts';
import Link from 'next/link';
import { bff, useSubmit } from '@/components/client';
import { ProfileDetailsView } from '@/components/ProfileDetailsView';
import { fmtTime } from '@/lib/format';

export type Member = { id: string; code: string; name: string };
export type ProfileGroup = { id: string; name: string; description: string; sourceIds: string[]; targetIds: string[] };
export type ProfileDirectory = { groups: ProfileGroup[]; sources: Member[];
  targets: Array<Member & { canComment: boolean; details: SyncedProfileDetails | null }> };

const blank = { name: '', description: '', sourceIds: [] as string[], targetIds: [] as string[] };

function GroupForm({ group, directory, onSaved }: { group?: ProfileGroup; directory: ProfileDirectory; onSaved: () => void }) {
  const [draft, setDraft] = useState(group ?? blank);
  const [query, setQuery] = useState('');
  const submit = useSubmit();
  const search = (value: string) => value.normalize('NFC').toLocaleLowerCase('vi');
  const memberFields = [
    { label: 'Hồ sơ A', key: 'sourceIds', members: directory.sources },
    { label: 'Hồ sơ B', key: 'targetIds', members: directory.targets },
  ] as const;
  return <form className="workflow-form" onSubmit={event => {
    event.preventDefault();
    submit.run(async () => {
      const response = await bff(group ? 'PUT' : 'POST', group ? `profile-groups/${group.id}` : 'profile-groups', draft);
      if (response.ok) onSaved();
      return response;
    });
  }}>
    <label>Tên nhóm<input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
    <label>Mô tả hoặc tiêu chí phân nhóm<textarea rows={2} maxLength={500} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
    <label>Tìm hồ sơ<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="workflow-columns">
      {memberFields.map(({ label, key, members }) => {
        const visible = members.filter(member => search(`${member.code} ${member.name}`).includes(search(query.trim())));
        return <fieldset key={key} className="member-list">
          <legend>{label} · {draft[key].length} đã chọn</legend>
          {visible.map(member => <label key={member.id}>
            <input type="checkbox" checked={draft[key].includes(member.id)} onChange={event => setDraft({ ...draft, [key]:
              event.target.checked ? [...draft[key], member.id] : draft[key].filter(id => id !== member.id) })} />
            <span>{member.code} · {member.name}</span>
          </label>)}
          {!visible.length && <p className="muted">Không có hồ sơ phù hợp.</p>}
        </fieldset>;
      })}
    </div>
    {submit.error && <p className="err" role="alert">{submit.error}</p>}
    <div className="actions">
      <button type="submit" className="primary" disabled={submit.pending}>{submit.pending ? 'Đang lưu…' : 'Lưu nhóm'}</button>
      <button type="button" onClick={onSaved}>Đóng</button>
    </div>
  </form>;
}

export function ProfileGroups({ directory, canEdit }: { directory: ProfileDirectory; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const group = directory.groups.find(item => item.id === editing);
  const members = (ids: string[]) => [...directory.sources, ...directory.targets].filter(item => ids.includes(item.id));
  return <div className="workflow-stack">
    {canEdit && <div className="actions"><button className="primary" onClick={() => setEditing('new')}>Tạo nhóm hồ sơ</button></div>}
    {editing && <section className="card workflow-stack">
      <h2>{group ? `Sửa nhóm ${group.name}` : 'Tạo nhóm hồ sơ'}</h2>
      <GroupForm key={editing} group={group} directory={directory} onSaved={() => setEditing(null)} />
    </section>}
    <div className="workflow-columns">
      {directory.groups.map(item => <section className="card workflow-stack" key={item.id}>
        <div className="workflow-toolbar"><h2>{item.name}</h2>
          {canEdit && <button type="button" className="sm" onClick={() => setEditing(item.id)}>Sửa nhóm</button>}
        </div>
        {item.description && <p>{item.description}</p>}
        {item.sourceIds.length + item.targetIds.length > 0
          ? <ul className="workflow-members">{members([...item.sourceIds, ...item.targetIds]).map(member =>
            <li key={member.id}><Link href={{ pathname: '/library', query: { profile: member.code } }}>{member.code} · {member.name}</Link></li>)}</ul>
          : <p className="muted">Chưa có thành viên.</p>}
      </section>)}
    </div>
    {!directory.groups.length && <p className="muted">Chưa có nhóm hồ sơ.</p>}
    {directory.targets.some(target => target.details) && <section className="card workflow-stack">
      <h2>Thông tin đã lưu vào hồ sơ B</h2>
      {directory.targets.map(target => target.details && <details key={target.id}>
        <summary>{target.code} · {target.name} · Từ {target.details.sourceCode} · {fmtTime(target.details.syncedAt)}</summary>
        <ProfileDetailsView snapshot={target.details.snapshot} />
      </details>)}
    </section>}
  </div>;
}
