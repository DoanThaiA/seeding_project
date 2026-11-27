'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton, bff, useSubmit } from '@/components/client';
import type { Member, ProfileGroup } from '../profile-groups/ProfileGroups';

type Status = 'DRAFT' | 'QUEUED' | 'SENDING' | 'FAILED' | 'UNKNOWN' | 'POSTED';
type StepInput = { targetId: string; text: string; replyTo: number | null; replyUrl: string | null };
type Step = StepInput & { id: string; position: number; sendVersion: number; status: Status; detail: string | null;
  permalink: string | null; target: { code: string; name: string } };
export type ScriptSummary = { id: string; name: string; startedAt: string | null; steps: { status: Status }[] };
export type Script = Omit<ScriptSummary, 'steps'> & { postUrl: string; resolvedUrl: string | null; version: number; steps: Step[] };
type Target = Member & { canComment: boolean };
type Draft = { name: string; postUrl: string; steps: Array<StepInput & { key: number }> };

const blankStep: StepInput = { targetId: '', text: '', replyTo: null, replyUrl: null };
const labels: Record<Status, string> = {
  DRAFT: 'Đang chờ', QUEUED: 'Chờ worker', SENDING: 'Đang gửi và xác minh', FAILED: 'Gửi chưa thành công',
  UNKNOWN: 'Cần đối chiếu', POSTED: 'Đã ghi nhận',
};

export function ScriptEditor({ script, groups, targets }: { script?: Script; groups: ProfileGroup[]; targets: Target[] }) {
  const router = useRouter();
  const submit = useSubmit();
  const [groupId, setGroupId] = useState('');
  const [dirty, setDirty] = useState(!script);
  const [draft, setDraft] = useState<Draft>(() => script ? { name: script.name, postUrl: script.postUrl,
    steps: script.steps.map(({ targetId, text, replyTo, replyUrl, position }) => ({ targetId, text, replyTo, replyUrl, key: position })) }
    : { name: '', postUrl: '', steps: [{ ...blankStep, key: 0 }] });
  const [nextKey, setNextKey] = useState(draft.steps.length);
  const group = groups.find(item => item.id === groupId);
  const save = (value: Draft) => { setDraft(value); setDirty(true); };
  const updateStep = (position: number, values: Partial<StepInput>) => save({ ...draft,
    steps: draft.steps.map((step, index) => index === position ? { ...step, ...values } : step) });
  const append = (replyTo: number | null) => {
    save({ ...draft, steps: [...draft.steps, { ...blankStep, replyTo, key: nextKey }] });
    setNextKey(key => key + 1);
  };
  const remove = (position: number) => save({ ...draft, steps: draft.steps.filter((_, index) => index !== position).map(step => ({
    ...step, replyTo: step.replyTo === position ? null : step.replyTo !== null && step.replyTo > position ? step.replyTo - 1 : step.replyTo,
  })) });
  return <section className="card workflow-stack">
    <h2>{script ? 'Sửa bản nháp' : 'Kịch bản mới'}</h2>
    <form className="workflow-form" onSubmit={event => {
      event.preventDefault();
      const steps = draft.steps.map(({ targetId, text, replyTo, replyUrl }) => ({ targetId, text, replyTo, replyUrl }));
      submit.run(async () => {
        const response = await bff<{ id: string }>(script ? 'PUT' : 'POST', script ? `comment-scripts/${script.id}` : 'comment-scripts',
          { name: draft.name, postUrl: draft.postUrl, steps, version: script?.version });
        if (response.ok && !script) router.replace(`/comment-scripts?id=${response.data.id}`);
        return response;
      }, 'Đã lưu bản nháp.');
    }}>
      <label>Tên kịch bản<input required maxLength={120} value={draft.name} onChange={event => save({ ...draft, name: event.target.value })} /></label>
      <label>Liên kết bài Facebook<input type="url" required maxLength={2000} value={draft.postUrl}
        onChange={event => save({ ...draft, postUrl: event.target.value })} placeholder="https://www.facebook.com/…" /></label>
      {groups.length > 0 && <label>Lọc hồ sơ B theo nhóm<select value={groupId} onChange={event => setGroupId(event.target.value)}>
        <option value="">Tất cả hồ sơ B</option>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {!targets.some(target => target.canComment) && <p className="muted">Cần hồ sơ B đang bật và đã cấu hình phiên Facebook.</p>}
      <ol className="workflow-steps">
        {draft.steps.map((step, index) => <li key={step.key} className="workflow-step workflow-form">
          <div className="workflow-toolbar"><h3>Bước {index + 1}</h3>
            <button type="button" className="sm" disabled={draft.steps.length === 1} onClick={() => remove(index)}>Xóa bước</button>
          </div>
          <div className="workflow-columns">
            <label>Hồ sơ B<select required value={step.targetId} onChange={event => updateStep(index, { targetId: event.target.value })}>
              <option value="">Chọn hồ sơ B</option>
              {targets.filter(target => target.id === step.targetId || target.canComment && (!group || group.targetIds.includes(target.id)))
                .map(target => <option key={target.id} value={target.id} disabled={!target.canComment}>{target.code} · {target.name}</option>)}
            </select></label>
            <label>Thao tác<select value={step.replyUrl !== null ? 'link' : step.replyTo ?? 'root'} onChange={event => {
              const value = event.target.value;
              updateStep(index, { replyTo: value === 'link' || value === 'root' ? null : Number(value), replyUrl: value === 'link' ? '' : null });
            }}>
              <option value="root">Bình luận vào bài viết</option><option value="link">Trả lời bình luận có sẵn</option>
              {draft.steps.slice(0, index).map((previous, position) => <option key={previous.key} value={position}>Trả lời bước {position + 1}</option>)}
            </select></label>
          </div>
          {step.replyUrl !== null && <label>Liên kết bình luận cần trả lời<input type="url" required maxLength={2000} value={step.replyUrl}
            onChange={event => updateStep(index, { replyUrl: event.target.value })} /></label>}
          <label>Nội dung {step.replyTo === null && step.replyUrl === null ? 'bình luận' : 'trả lời'}<textarea rows={3} required maxLength={8000}
            value={step.text} onChange={event => updateStep(index, { text: event.target.value })} /></label>
          <div className="actions"><button className="sm" type="button" disabled={draft.steps.length >= 50}
            onClick={() => append(index)}>Thêm phản hồi cho bước này</button></div>
        </li>)}
      </ol>
      <div className="actions">
        <button type="button" disabled={draft.steps.length >= 50} onClick={() => append(null)}>Thêm bình luận</button>
        <button type="submit" className="primary" disabled={submit.pending || !dirty}>{submit.pending ? 'Đang lưu…' : 'Lưu bản nháp'}</button>
        {script && <ActionButton path={`comment-scripts/${script.id}/start`} body={{ version: script.version }} disabled={dirty || submit.pending}
          confirm={`Chạy ${script.steps.length} bước đã lưu trên bài Facebook này?`}>Chạy kịch bản</ActionButton>}
      </div>
      {submit.error && <p role="alert" className="err">{submit.error}</p>}
      {submit.done && <p role="status" className="okmsg">{submit.done}</p>}
    </form>
  </section>;
}

function ResolveStep({ scriptId, step }: { scriptId: string; step: Step }) {
  const [permalink, setPermalink] = useState('');
  const submit = useSubmit();
  const path = `comment-scripts/${scriptId}/steps/${step.id}/resolve`;
  const unknown = step.status === 'UNKNOWN';
  return <div className="workflow-stack">
    {unknown && <form className="workflow-form" onSubmit={event => {
      event.preventDefault();
      submit.run(() => bff('POST', path, { action: 'confirm', sendVersion: step.sendVersion, permalink }), 'Đã xác nhận bình luận.');
    }}>
      <label>Liên kết bình luận đã đối chiếu trên Facebook<input required type="url" value={permalink} maxLength={2000}
        onChange={event => setPermalink(event.target.value)} /></label>
      <div className="actions"><button type="submit" disabled={submit.pending}>Xác nhận và tiếp tục</button></div>
      {submit.error && <p className="err" role="alert">{submit.error}</p>}
    </form>}
    <div className="actions"><ActionButton path={path} body={{ action: 'retry', sendVersion: step.sendVersion, checkedMissing: unknown }}
      confirm={unknown ? 'Bạn đã mở bài trên Facebook và xác nhận bình luận này chưa xuất hiện?' : undefined}>
      {unknown ? 'Đã kiểm tra, gửi lại bước' : 'Gửi lại bước'}
    </ActionButton></div>
  </div>;
}

export function ScriptRun({ script, canOperate }: { script: Script; canOperate: boolean }) {
  const posted = script.steps.filter(step => step.status === 'POSTED').length;
  return <section className="card workflow-stack">
    <div className="workflow-toolbar"><h2>{script.name}</h2><a href={script.resolvedUrl ?? script.postUrl} target="_blank" rel="noreferrer">Mở bài Facebook</a></div>
    <p role="status">{script.startedAt ? `${posted}/${script.steps.length} bước đã gửi` : 'Bản nháp'}</p>
    <ol className="workflow-steps">{script.steps.map(step => <li key={step.id} className="workflow-step workflow-stack">
      <div className="workflow-toolbar"><h3>Bước {step.position + 1} · {step.target.code} · {step.target.name}</h3>
        <span>{step.status === 'DRAFT' && !script.startedAt ? 'Bản nháp' : labels[step.status]}</span></div>
      <p className="muted">{step.replyTo !== null ? `Trả lời bước ${step.replyTo + 1}`
        : step.replyUrl ? <a href={step.replyUrl} target="_blank" rel="noreferrer">Trả lời bình luận có sẵn</a> : 'Bình luận vào bài viết'}</p>
      <p className="workflow-message">{step.text}</p>
      {step.detail && <p className={step.status === 'FAILED' || step.status === 'UNKNOWN' ? 'err' : 'muted'}>{step.detail}</p>}
      {step.permalink && <a href={step.permalink} target="_blank" rel="noreferrer">Mở bình luận</a>}
      {canOperate && (step.status === 'FAILED' || step.status === 'UNKNOWN') && <ResolveStep key={step.sendVersion} scriptId={script.id} step={step} />}
    </li>)}</ol>
  </section>;
}
