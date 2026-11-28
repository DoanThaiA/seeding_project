'use client';

import { PERSONA_GENDER_TEXT } from '@seedingsys/contracts';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ActionButton, bff, useSubmit } from '@/components/client';
import type { PersonaDetail, PersonaSummary } from '../personas/types';
import { PostContent, useCommentJob, type GeneratedDraft, type PostSnapshot } from './PostPreparation';

type Status = 'DRAFT' | 'QUEUED' | 'SENDING' | 'FAILED' | 'UNKNOWN' | 'POSTED';
type StepInput = { targetId: string; text: string; replyTo: number | null; replyUrl: string | null };
type Step = StepInput & { id: string; position: number; sendVersion: number; status: Status; detail: string | null;
  permalink: string | null; target: { code: string; name: string } };
export type ScriptSummary = { id: string; name: string; startedAt: string | null; steps: { status: Status }[] };
export type Script = Omit<ScriptSummary, 'steps'> & { postUrl: string; resolvedUrl: string | null; postSnapshot: PostSnapshot | null;
  version: number; steps: Step[] };
type Draft = { name: string; postUrl: string; steps: Array<StepInput & { key: number }> };

const blankStep: StepInput = { targetId: '', text: '', replyTo: null, replyUrl: null };
const labels: Record<Status, string> = {
  DRAFT: 'Đang chờ', QUEUED: 'Chờ worker', SENDING: 'Đang gửi và xác minh', FAILED: 'Gửi chưa thành công',
  UNKNOWN: 'Cần đối chiếu', POSTED: 'Đã ghi nhận',
};

function PersonaContext({ target }: { target: PersonaSummary }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PersonaDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || details) return;
    const abort = new AbortController();
    fetch(`/bff/personas/${target.id}`, { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error();
      return response.json() as Promise<PersonaDetail>;
    }).then(setDetails).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [open, details, target.id]);
  const bio = details ? details.context?.bio : target.description;
  const sourceCode = details ? details.context?.sourceCode : target.sourceCode;
  const posts = (details?.wall?.posts.length ? details.wall.posts : details?.publications ?? []).slice(0, 2);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Ngữ cảnh của {target.code}</summary>
    <div className="workflow-stack">
      {details?.context?.name && <strong>{details.context.name}</strong>}
      {sourceCode && <small className="muted">Hồ sơ lưu từ {sourceCode}</small>}
      {bio && <p className="workflow-message">{bio}</p>}
      {posts.map(post => <p className="workflow-message" key={post.id}>{post.caption.slice(0, 240) || 'Bài không có caption'}{post.caption.length > 240 ? '…' : ''}</p>)}
      {failed && !details && <p className="muted">Chưa tải được dữ liệu nhân vật.</p>}
      <Link target="_blank" rel="noreferrer" href={{ pathname: '/personas', query: { profile: target.code } }}>Mở hồ sơ và bài đã đăng</Link>
    </div>
  </details>;
}

export function ScriptEditor({ script, targets, defaultTargetId }: { script?: Script; targets: PersonaSummary[]; defaultTargetId?: string }) {
  const router = useRouter();
  const submit = useSubmit();
  const [dirty, setDirty] = useState(!script);
  const [draft, setDraft] = useState<Draft>(() => script ? { name: script.name, postUrl: script.postUrl,
    steps: script.steps.map(({ targetId, text, replyTo, replyUrl, position }) => ({ targetId, text, replyTo, replyUrl, key: position })) }
    : { name: '', postUrl: '', steps: [{ ...blankStep, targetId: defaultTargetId ?? '', key: 0 }] });
  const [nextKey, setNextKey] = useState(draft.steps.length);
  const [post, setPost] = useState<PostSnapshot | null>(script?.postSnapshot ?? null);
  const [reader, setReader] = useState(defaultTargetId ?? script?.steps[0]?.targetId ?? (targets.filter(target => target.canComment).length === 1
    ? targets.find(target => target.canComment)!.id : ''));
  const [request, setRequest] = useState('');
  const readJob = useCommentJob<PostSnapshot>();
  const aiJob = useCommentJob<GeneratedDraft>();
  const [generated, setGenerated] = useState(false);
  const busy = readJob.pending || aiJob.pending || submit.pending;
  const canDraft = !!post || (!!script && script.postUrl === draft.postUrl);
  const byId = new Map(targets.map(target => [target.id, target]));
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
    <form className="workflow-form" onSubmit={async event => {
      event.preventDefault();
      setGenerated(false);
      aiJob.clearError();
      const result = await readJob.run('comment-scripts/post-previews', { postUrl: draft.postUrl, targetId: reader });
      if (result) {
        setPost(result);
        setDirty(true);
      }
    }}>
      <label>Liên kết bài Facebook<input type="url" required maxLength={2000} value={draft.postUrl} disabled={busy}
        onChange={event => {
          const postUrl = event.target.value;
          setPost(postUrl === script?.postUrl ? script.postSnapshot : null);
          readJob.clearError();
          aiJob.clearError();
          setGenerated(false);
          save({ ...draft, postUrl });
        }} placeholder="https://www.facebook.com/…" /></label>
      <label>Tài khoản B dùng để xem bài<select required value={reader} disabled={busy} onChange={event => setReader(event.target.value)}>
        <option value="">Chọn tài khoản B</option>
        {targets.filter(target => target.canComment).map(target => <option key={target.id} value={target.id}>{target.code} · {target.name}</option>)}
      </select></label>
      <div className="actions"><button type="submit" className={post ? '' : 'primary'} disabled={busy || !byId.get(reader)?.canComment}>
        {readJob.pending ? 'Đang lấy bài viết…' : post ? 'Lấy lại bài viết' : 'Lấy bài viết'}
      </button></div>
      {readJob.error && <p className="err" role="alert">{readJob.error}</p>}
    </form>
    {post && <PostContent post={post} />}
    {post?.previewId && <form className="workflow-form workflow-step" onSubmit={async event => {
      event.preventDefault();
      if (draft.steps.some(step => step.text.trim()) && !window.confirm('Thay các bước đang soạn bằng bản nháp mới do AI tạo?')) return;
      setGenerated(false);
      const result = await aiJob.run(`comment-scripts/post-previews/${post.previewId}/generations`, { request });
      if (!result) return;
      save({ ...draft, name: result.name, steps: result.steps.map((step, key) => ({ ...step, key: nextKey + key, replyUrl: null })) });
      setNextKey(key => key + result.steps.length);
      setGenerated(true);
    }}>
      <label>Yêu cầu cho AI<textarea required maxLength={2000} rows={3} value={request} disabled={busy}
        onChange={event => setRequest(event.target.value)} placeholder="Ví dụ 2 bình luận ngắn hỏi thêm về nội dung bài và 1 phản hồi cho bình luận đầu." /></label>
      <div className="actions"><button type="submit" disabled={busy || !request.trim()}>
        {aiJob.pending ? 'AI đang soạn kịch bản…' : 'Tạo kịch bản bằng AI'}
      </button></div>
      {aiJob.error && <p className="err" role="alert">{aiJob.error}</p>}
      {generated && <p className="okmsg" role="status">AI đã soạn bản nháp. Kiểm tra nội dung, nhân vật và nhánh trả lời trước khi lưu.</p>}
    </form>}
    {canDraft && <form className="workflow-form" onSubmit={event => {
      event.preventDefault();
      const steps = draft.steps.map(({ targetId, text, replyTo, replyUrl }) => ({ targetId, text, replyTo, replyUrl }));
      submit.run(async () => {
        const response = await bff<{ id: string }>(script ? 'PUT' : 'POST', script ? `comment-scripts/${script.id}` : 'comment-scripts',
          { name: draft.name, postUrl: draft.postUrl, previewId: post?.previewId, steps, version: script?.version });
        if (response.ok && !script) router.replace(`/comment-scripts?id=${response.data.id}`);
        return response;
      }, 'Đã lưu bản nháp.');
    }}>
      <label>Tên kịch bản<input required maxLength={120} value={draft.name} disabled={busy} onChange={event => save({ ...draft, name: event.target.value })} /></label>
      {!targets.some(target => target.canComment) && <p className="muted">Cần hồ sơ B đang bật và đã cấu hình phiên Facebook.</p>}
      <ol className="workflow-steps">
        {draft.steps.map((step, index) => <li key={step.key} className="workflow-step workflow-form"><fieldset disabled={busy} className="workflow-fields">
          <div className="workflow-toolbar"><h3>Bước {index + 1}</h3>
            <button type="button" className="sm" disabled={draft.steps.length === 1} onClick={() => remove(index)}>Xóa bước</button>
          </div>
          <div className="workflow-columns">
            <label>Nhân vật B<select required value={step.targetId} onChange={event => updateStep(index, { targetId: event.target.value })}>
              <option value="">Chọn nhân vật B</option>
              {targets.filter(target => target.id === step.targetId || target.canComment)
                .map(target => <option key={target.id} value={target.id} disabled={!target.canComment}>
                  {[`${target.code} · ${target.name}`, target.insight?.occupation,
                    target.insight && PERSONA_GENDER_TEXT[target.insight.gender], target.insight?.location]
                    .filter(Boolean).join(' · ')}
                </option>)}
            </select></label>
            <label>Thao tác<select value={step.replyUrl !== null ? 'link' : step.replyTo ?? 'root'} onChange={event => {
              const value = event.target.value;
              updateStep(index, { replyTo: value === 'link' || value === 'root' ? null : Number(value), replyUrl: value === 'link' ? '' : null });
            }}>
              <option value="root">Bình luận vào bài viết</option><option value="link">Trả lời bình luận có sẵn</option>
              {draft.steps.slice(0, index).map((previous, position) => <option key={previous.key} value={position}>Trả lời bước {position + 1}</option>)}
            </select></label>
          </div>
          {byId.has(step.targetId) && <PersonaContext key={step.targetId} target={byId.get(step.targetId)!} />}
          {step.replyUrl !== null && <label>Liên kết bình luận cần trả lời<input type="url" required maxLength={2000} value={step.replyUrl}
            onChange={event => updateStep(index, { replyUrl: event.target.value })} /></label>}
          <label>Nội dung {step.replyTo === null && step.replyUrl === null ? 'bình luận' : 'trả lời'}<textarea rows={3} required maxLength={8000}
            value={step.text} onChange={event => updateStep(index, { text: event.target.value })} /></label>
          <div className="actions"><button className="sm" type="button" disabled={draft.steps.length >= 50}
            onClick={() => append(index)}>Thêm phản hồi cho bước này</button></div>
        </fieldset></li>)}
      </ol>
      <div className="actions">
        <button type="button" disabled={busy || draft.steps.length >= 50} onClick={() => append(null)}>Thêm bình luận</button>
        <button type="submit" className="primary" disabled={busy || !dirty}>{submit.pending ? 'Đang lưu…' : 'Lưu bản nháp'}</button>
        {script && <ActionButton path={`comment-scripts/${script.id}/start`} body={{ version: script.version }} disabled={dirty || busy}
          confirm={`Chạy ${script.steps.length} bước đã lưu trên bài Facebook này?`}>Chạy kịch bản</ActionButton>}
      </div>
      {submit.error && <p role="alert" className="err">{submit.error}</p>}
      {submit.done && <p role="status" className="okmsg">{submit.done}</p>}
    </form>}
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
    {script.postSnapshot && <PostContent post={script.postSnapshot} />}
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
