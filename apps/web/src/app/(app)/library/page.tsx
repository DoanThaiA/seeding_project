import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiError, apiGet, can, getSession } from '@/lib/api';
import { ActionButton, AutoRefresh } from '@/components/client';
import { ProfileDetailsView } from '@/components/ProfileDetailsView';
import { Badge } from '@/components/ui';
import { fmtTime, label, reasonText } from '@/lib/format';
import { PERSONA_CONFIDENCE_TEXT, PERSONA_GENDER_TEXT, SUCCESS, TARGET_HEALTH_TEXT,
  type TargetHealthResult } from '@seedingsys/contracts';
import { ProfileDetailsPanel, type ProfileDetailsState } from '../profile-sync/ProfileDetailsPanel';
import type { PersonaDetail, PersonaSummaryRow } from '../personas/types';
import { PostWorkspace } from './PostWorkspace';
import { ProfilePicker } from './ProfilePicker';
import type { Listing, PostDetail, Profiles } from './types';
import styles from './library.module.css';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const READABLE = ['fb-public', 'fb-session'];

interface TargetHealth {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  connector: string;
  checkable: boolean;
  status: string | null;
  message: string | null;
  checkedAt: string | null;
  result: TargetHealthResult | null;
}

interface Mapping {
  id: string;
  sourceId: string;
  targetId: string;
  enabled: boolean;
}

function href(query: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
  return '/library?' + search.toString();
}

/** Caption dài thì gập lại để một bài nhiều chữ không che hết phần còn lại. */
function PostText({ text, className }: { text: string; className: string }) {
  if (!text) return null;
  if (text.length <= 450) return <p className={className}>{text}</p>;
  return <details><summary>Xem nội dung bài</summary><p className={className}>{text}</p></details>;
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  const input = await searchParams;
  const read = (key: string) => typeof input[key] === 'string' ? input[key] : undefined;
  const profiles = await apiGet<Profiles>('/library/profiles', session.token);
  const choices = [...profiles.sources, ...profiles.targets];
  const kindParam = read('kind')?.toUpperCase();
  const kind = kindParam === 'A' || kindParam === 'B' ? kindParam : undefined;
  const pool = kind === 'A' ? profiles.sources : kind === 'B' ? profiles.targets : choices;
  const title = kind === 'A' ? 'Hồ sơ A' : kind === 'B' ? 'Hồ sơ B' : 'Hồ sơ A và B';
  const profile = pool.find(p => p.code === read('profile')?.toUpperCase()) ?? pool[0];
  if (!profile) return <><h1>{title}</h1><p>{kind ? `Chưa có hồ sơ ${kind}.` : 'Chưa có hồ sơ nguồn hoặc đích.'}</p>
    {can.admin(session.role) && <Link href="/settings">Mở Quản trị luồng đăng</Link>}</>;
  // Link từ trang khác chỉ mang ?profile=; thêm phía A/B để sidebar biết mục nào đang mở.
  if (!kind) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (typeof value === 'string') search.set(key, value);
    search.set('profile', profile.code);
    search.set('kind', profiles.sources.some(item => item.id === profile.id) ? 'A' : 'B');
    redirect('/library?' + search);
  }
  const q = (read('q') ?? '').slice(0, 120);
  const trash = read('trash') === '1' ? '1' : undefined;
  const page = Math.max(1, Math.min(2000, Number.parseInt(read('page') ?? '1', 10) || 1));
  const postId = read('post')?.toLowerCase();
  const pickedPartner = read('source')?.toUpperCase();
  const admin = can.admin(session.role);
  const source = profiles.sources.find(item => item.id === profile.id);
  const target = profiles.targets.find(item => item.id === profile.id);
  const query = new URLSearchParams({ page: String(page), q, ...(trash && { trash }) });
  const [listing, candidate, persona, mappings, health, summaries] = await Promise.all([
    apiGet<Listing>(`/library/profiles/${encodeURIComponent(profile.code)}?` + query, session.token),
    postId && UUID.test(postId) ? apiGet<PostDetail>('/library/posts/' + postId, session.token).catch(error => {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return null;
    }) : null,
    // Phần B hiển thị mọi thông tin SeedingSys biết về chính tài khoản đó, không chỉ bài viết.
    target ? apiGet<PersonaDetail>(`/personas/${profile.id}`, session.token).catch(() => null) : null,
    apiGet<Mapping[]>('/mappings', session.token).catch(() => [] as Mapping[]),
    // Bảng kiểm tra tài khoản B dùng chung cho cả phần Hồ sơ B, nên chỉ tải khi đang ở phía B.
    kind === 'B' && admin ? apiGet<TargetHealth[]>('/targets/health', session.token).catch(() => null) : null,
    kind === 'B' && can.operate(session.role)
      ? apiGet<PersonaSummaryRow[]>('/personas/summaries', session.token).catch(() => null) : null,
  ]);
  const belongsToProfile = candidate && (source
    ? candidate.source.id === profile.id && !!candidate.post.archivedAt === !!trash
    : candidate.destinations.some(destination => destination.target.id === profile.id && (destination.variant || destination.publication)
      && (!candidate.post.archivedAt || (!!destination.publication && SUCCESS.includes(destination.publication.status)))));
  const detail = belongsToProfile ? candidate : null;
  const requestedTarget = listing.kind === 'target' ? profile.code : read('to');
  const canReview = can.review(session.role);
  const canOperate = can.operate(session.role);
  const link = (extra: Record<string, string | undefined> = {}) =>
    href({ profile: profile.code, kind, source: pickedPartner, ...extra });

  // Ghép với phía còn lại: A chọn B mình đăng sang, B chọn A mình nạp dữ liệu từ đó.
  const live = mappings.filter(item => item.enabled);
  const partners = source
    ? live.filter(item => item.sourceId === profile.id).flatMap(item => {
      const found = profiles.targets.find(entry => entry.id === item.targetId);
      return found ? [{ id: item.id, profile: found, connector: source.connector }] : [];
    })
    : live.filter(item => item.targetId === profile.id).flatMap(item => {
      const found = profiles.sources.find(entry => entry.id === item.sourceId);
      return found ? [{ id: item.id, profile: found, connector: found.connector }] : [];
    });
  const partner = partners.find(item => item.profile.code === pickedPartner)
    ?? (persona?.sourceProfile ? partners.find(item => item.profile.code === persona.sourceProfile?.sourceCode) : undefined)
    ?? partners[0];
  const sourceCode = source ? source.code : partner?.profile.code;
  const details = admin && partner && READABLE.includes(partner.connector) && (!!source || persona?.connector === 'fb-web')
    ? await apiGet<ProfileDetailsState>(`/profile-details/${partner.id}`, session.token).catch(() => null) : null;
  const checking = !!health?.some(row => ['QUEUED', 'RUNNING', 'OPEN'].includes(row.status ?? ''));
  const tally = {
    alive: health?.filter(row => row.result?.ok).length ?? 0,
    broken: health?.filter(row => row.result && !row.result.ok).length ?? 0,
    disabled: health?.filter(row => row.result?.disabled).length ?? 0,
    running: health?.filter(row => ['QUEUED', 'RUNNING', 'OPEN'].includes(row.status ?? '')).length ?? 0,
    unchecked: health?.filter(row => !row.result && !['QUEUED', 'RUNNING', 'OPEN', 'FAILED'].includes(row.status ?? '')).length ?? 0,
  };
  const summarizing = !!summaries?.some(row => ['QUEUED', 'RUNNING'].includes(row.status ?? ''))
    || ['QUEUED', 'RUNNING'].includes(persona?.insightRun?.status ?? '');
  const readingProfile = ['QUEUED', 'READING'].includes(details?.scan?.status ?? '')
    || ['QUEUED', 'RUNNING', 'COMMITTING'].includes(details?.scan?.bioStatus ?? '');

  return (
    <div className={styles.workspace}>
      {readingProfile && <AutoRefresh seconds={5} />}
      <header className={styles.heading}>
        <h1>{title}</h1>
        <ProfilePicker profiles={profiles} selected={profile.code} kind={kind} />
      </header>
      <section className={styles.profileBar} aria-label="Thông tin hồ sơ">
        <div>
          <Badge s={profile.enabled ? 'OK' : 'PAUSED'} text={profile.enabled ? 'Đang bật' : 'Đã tắt'} />
          <strong>{profile.code} · {profile.name}</strong>
          <span className="muted">{source ? `${source._count.posts} bài đã lưu` : `${target?._count.publications ?? 0} bài đã đăng`}</span>
        </div>
        <div className="actions">
          {source?.enabled && admin && <ActionButton path={`sources/${source.id}/poll`}>Quét bài của {source.code}</ActionButton>}
          {persona?.profileUrl && <a className="btn" href={persona.profileUrl} target="_blank" rel="noreferrer">Mở hồ sơ Facebook</a>}
          {persona?.canComment && canOperate && <Link className="btn" href={{ pathname: '/comment-scripts', query: { new: '1', profile: profile.code } }}>Gán vào kịch bản</Link>}
          <Link className="btn" href={{ pathname: '/profile-sync', query: source ? { source: profile.code } : { target: profile.code } }}>Đồng bộ hồ sơ</Link>
        </div>
      </section>
      {health && <section className="card workflow-stack" aria-labelledby="health">
        {checking && <AutoRefresh seconds={6} />}
        <div className="workflow-toolbar">
          <h2 id="health">Kiểm tra tài khoản B</h2>
          <div className="actions">
            <ActionButton className="primary" path="targets/health-check" body={{}}
              confirm={'Mở lần lượt trình duyệt của các tài khoản B đang bật để kiểm tra. Tài khoản không còn hoạt động sẽ bị tắt nguồn. Tiếp tục?'}>
              Kiểm tra tất cả B đang bật
            </ActionButton>
            {target && <ActionButton path="targets/health-check" body={{ targetId: profile.id }}>Chỉ kiểm tra {profile.code}</ActionButton>}
          </div>
        </div>
        <p className="muted">
          {health.length} tài khoản B · Còn hoạt động {tally.alive} · Hỏng {tally.broken} · Đang kiểm tra {tally.running} · Chưa kiểm tra {tally.unchecked}
          {tally.disabled > 0 && ` · Đã tự tắt nguồn ${tally.disabled}`}
        </p>
        <table>
          <thead><tr><th>Tài khoản</th><th>Kết quả kiểm tra</th><th>Lần kiểm tra</th><th>Nguồn B</th></tr></thead>
          <tbody>
            {health.map(row => {
              const running = ['QUEUED', 'RUNNING', 'OPEN'].includes(row.status ?? '');
              return <tr key={row.id}>
                <td><Link href={href({ profile: row.code, kind: 'B' })}>{row.code}</Link> · {row.name}</td>
                <td>
                  {running ? <Badge s="STARTED" text="Đang kiểm tra" />
                    : row.result ? <Badge s={row.result.ok ? 'OK' : 'NEEDS_OPERATOR'} text={TARGET_HEALTH_TEXT[row.result.state]} />
                    : row.status === 'FAILED' ? <Badge s="DEFERRED" text="Không kiểm tra được" />
                    : <Badge s="CANCELLED" text={row.checkable ? 'Chưa kiểm tra' : 'Chưa đăng nhập trình duyệt'} />}
                  {row.result?.observed && row.result.state === 'WRONG_ACCOUNT' && <span className="muted"> {row.result.observed}</span>}
                  {!running && row.status === 'FAILED' && row.message && <><br /><span className="muted">{row.message}</span></>}
                </td>
                <td className="muted">{row.checkedAt ? fmtTime(row.checkedAt) : '—'}</td>
                <td><Badge s={row.enabled ? 'OK' : 'PAUSED'} text={row.enabled ? 'Đang bật' : 'Đã tắt'} /></td>
              </tr>;
            })}
          </tbody>
        </table>
        {!health.length && <p className="muted">Chưa có tài khoản B nào.</p>}
      </section>}
      {(persona || partners.length > 0) && <section className="card workflow-stack" aria-labelledby="profile-info">
        <div className="workflow-toolbar">
          <h2 id="profile-info">Thông tin hồ sơ {profile.code}</h2>
          {partners.length > 0 && <span className="muted">
            {source ? 'Đăng sang: ' : 'Nạp dữ liệu từ: '}{partners.map(item => item.profile.code).join(' · ')}
          </span>}
        </div>
        {persona?.context?.name && !persona.sourceProfile ? <p>{persona.context.name}
          {persona.context.sourceCode && <span className="muted"> · Lưu từ {persona.context.sourceCode}</span>}</p> : null}
        {persona?.sourceProfile ? <details open>
          <summary>Thông tin lưu từ {persona.sourceProfile.sourceCode} · {fmtTime(persona.sourceProfile.syncedAt)}</summary>
          <ProfileDetailsView snapshot={persona.sourceProfile.snapshot} />
        </details> : persona?.context?.bio ? <p className={styles.wallCaption}>{persona.context.bio}</p> : null}
        {persona && !persona.sourceProfile && !persona.context?.name && <p className="muted">Chưa có thông tin lưu từ A.</p>}
        {partners.length > 1 && <div className="actions" aria-label={source ? 'Chọn đích B' : 'Chọn nguồn A'}>
          {partners.map(item => <Link key={item.id} className="btn" aria-current={partner?.id === item.id ? 'true' : undefined}
            href={link({ source: item.profile.code })}>{item.profile.code} · {item.profile.name}</Link>)}
        </div>}
        {partner && <div className="actions">
          <Link href={{ pathname: '/profile-sync', query: source
            ? { source: profile.code, target: partner.profile.code }
            : { source: partner.profile.code, target: profile.code } }}>
            {source ? `Đồng bộ bài viết ${profile.code} → ${partner.profile.code}` : `Đồng bộ bài viết ${partner.profile.code} → ${profile.code}`}
          </Link>
          <Link href={href({ profile: partner.profile.code, kind: source ? 'B' : 'A' })}>Mở {partner.profile.code}</Link>
        </div>}
        {details && partner && sourceCode && <ProfileDetailsPanel key={partner.id} mappingId={partner.id} source={sourceCode}
          target={source ? partner.profile.code : profile.code} state={details} heading={`Hồ sơ nguồn ${sourceCode}`}
          showSaved={false} showFacebookActions={false} />}
      </section>}
      {persona?.wall && <section className="card workflow-stack" aria-labelledby="profile-wall">
        <div className="workflow-toolbar">
          <h2 id="profile-wall">Bài Facebook của {profile.code}</h2>
          <span className="muted">Bản lưu từ {fmtTime(persona.wall.capturedAt)}</span>
        </div>
        {persona.wall.warning && <p className="muted">{persona.wall.warning}</p>}
        {persona.wall.posts.map(post => <article className={styles.wallPost} key={post.id}>
          <div className="workflow-toolbar">
            <span>{label(post.contentType)}{post.postedAt ? ` · ${post.postedAtExact === false ? 'khoảng ' : ''}${fmtTime(post.postedAt)}` : ''}</span>
            <a href={post.permalink} target="_blank" rel="noreferrer">Mở bài trên Facebook</a>
          </div>
          <PostText text={post.caption} className={styles.wallCaption} />
          {post.incomplete.includes('CAPTION_TRUNCATED') && <small className="muted">{reasonText('CAPTION_TRUNCATED')}</small>}
        </article>)}
        {!persona.wall.posts.length && <p className="muted">Chưa có bài xác nhận được trong lượt quét.</p>}
      </section>}
      {summaries && <section className="card workflow-stack" aria-labelledby="persona-insight">
        {summarizing && <AutoRefresh seconds={6} />}
        <div className="workflow-toolbar">
          <h2 id="persona-insight">Tóm tắt hồ sơ nhân vật (AI)</h2>
          <div className="actions">
            {target && <ActionButton className="primary" path="personas/summaries" body={{ targetId: profile.id }}>
              Tóm tắt {profile.code}
            </ActionButton>}
            <ActionButton path="personas/summaries" body={{}}
              confirm={'Dùng AI suy đoán hồ sơ của mọi nhân vật đang bật, từ hồ sơ đã lưu và các bài của chính nhân vật. Tiếp tục?'}>
              Tóm tắt tất cả nhân vật
            </ActionButton>
          </div>
        </div>
        <p className="muted">
          Suy đoán nghề nghiệp, giới tính, nơi sống và tính cách từ hồ sơ đã lưu cùng tối đa 5 bài của chính nhân vật.
          Phần Kịch bản bình luận dùng bản tóm tắt này để chọn nhân vật phù hợp.
        </p>
        {persona?.insightRun && ['QUEUED', 'RUNNING'].includes(persona.insightRun.status)
          && <p role="status">Đang tóm tắt {profile.code}…</p>}
        {persona?.insightRun?.status === 'FAILED' && persona.insightRun.message
          && <p className="err" role="alert">{persona.insightRun.message}</p>}
        {persona?.insight ? <dl className={styles.insight}>
          <dt>Nghề nghiệp</dt><dd>{persona.insight.occupation ?? 'Chưa rõ'}</dd>
          <dt>Giới tính</dt><dd>{PERSONA_GENDER_TEXT[persona.insight.gender]}</dd>
          <dt>Tuổi</dt><dd>{persona.insight.ageRange ?? 'Chưa rõ'}</dd>
          <dt>Nơi sống</dt><dd>{persona.insight.location ?? 'Chưa rõ'}</dd>
          <dt>Tính cách</dt><dd>{persona.insight.traits.join(' · ') || 'Chưa rõ'}</dd>
          <dt>Sở thích</dt><dd>{persona.insight.interests.join(' · ') || 'Chưa rõ'}</dd>
          <dt>Chủ đề bình luận được</dt><dd>{persona.insight.topics.join(' · ') || 'Chưa rõ'}</dd>
          <dt>Giọng điệu</dt><dd>{persona.insight.voice ?? 'Chưa rõ'}</dd>
          <dt>Không được nói</dt><dd>{persona.insight.avoid.join(' · ') || 'Không có ghi chú'}</dd>
          <dt>Mô tả</dt><dd>{persona.insight.summary}</dd>
          <dt>Nguồn suy đoán</dt><dd className="muted">
            {persona.insight.basedOnPosts} bài{persona.insight.usedProfile ? ' và hồ sơ đã lưu' : ''}
            {' · '}{PERSONA_CONFIDENCE_TEXT[persona.insight.confidence]}
            {' · '}{fmtTime(persona.insight.generatedAt)}
          </dd>
        </dl> : target ? <p className="muted">Chưa có bản tóm tắt cho {profile.code}.</p> : null}
        <table>
          <thead><tr><th>Nhân vật</th><th>Nghề nghiệp · Giới tính · Nơi sống</th><th>Lần tóm tắt</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {summaries.map(row => {
              const running = ['QUEUED', 'RUNNING'].includes(row.status ?? '');
              return <tr key={row.id}>
                <td><Link href={href({ profile: row.code, kind: 'B' })}>{row.code}</Link> · {row.name}</td>
                <td>{row.insight
                  ? [row.insight.occupation, PERSONA_GENDER_TEXT[row.insight.gender], row.insight.location].filter(Boolean).join(' · ')
                  : <span className="muted">{row.hasProfile ? 'Chưa tóm tắt' : 'Chưa có hồ sơ đã lưu'}</span>}</td>
                <td className="muted">{row.runAt ? fmtTime(row.runAt) : '—'}</td>
                <td>
                  {running ? <Badge s="STARTED" text="Đang tóm tắt" />
                    : row.status === 'FAILED' ? <Badge s="DEFERRED" text="Chưa tóm tắt được" />
                    : row.insight ? <Badge s="OK" text={PERSONA_CONFIDENCE_TEXT[row.insight.confidence]} />
                    : <Badge s="CANCELLED" text="Chưa chạy" />}
                  {!running && row.status === 'FAILED' && row.message && <><br /><span className="muted">{row.message}</span></>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>}
      <div className={styles.body}>
        <aside className={styles.list}>
          <div className={styles.listHeading}><strong>{source ? 'Bài nguồn' : 'Bài đã đăng qua SeedingSys'}</strong></div>
          {source && <div className={styles.trashNav}>
            <Link href={link()} aria-current={!trash ? 'page' : undefined}>Bài trong kho</Link>
            <Link href={link({ trash: '1' })} aria-current={trash ? 'page' : undefined}>Thùng rác</Link>
          </div>}
          {source && <p className="muted">
            {source.lastSuccessAt ? `Quét lần cuối ${fmtTime(source.lastSuccessAt)}` : 'Chưa có lượt quét thành công'}
            {!!source.lastIncomplete?.length && <><br />{source.lastIncomplete.map(reasonText).join(' · ')}</>}
            {source.lastError && <><br /><span className="err">{source.lastError}</span></>}
          </p>}
          {listing.kind === 'target' && <p className="muted">Các bài do SeedingSys theo dõi cho {profile.code}.</p>}
          <form action="/library" className={styles.search}>
            <input type="hidden" name="profile" value={profile.code} />
            {kind && <input type="hidden" name="kind" value={kind} />}
            {pickedPartner && <input type="hidden" name="source" value={pickedPartner} />}
            {trash && <input type="hidden" name="trash" value={trash} />}
            <input name="q" defaultValue={q} maxLength={120} placeholder="Tìm theo caption" aria-label="Tìm theo caption" />
            <button className="sm" type="submit">Tìm</button>
          </form>
          {!listing.posts.length && <p className="muted">{q ? 'Không tìm thấy bài phù hợp.' : trash ? 'Thùng rác trống.' : 'Profile này chưa có bài trong kho.'}</p>}
          {listing.posts.map(p => (
            <Link className={styles.listItem} key={p.id} href={link({ q, page: String(page), post: p.id, trash })}
              aria-current={detail?.post.id === p.id ? 'page' : undefined}>
              <div><Badge s={p.contentType} /> {p.archivedAt ? <Badge s="CANCELLED" text="Trong thùng rác" /> : <Badge s={p.status} />}</div>
              <strong>{p.snippet || 'Bài không có caption'}</strong>
              <span>{p.sourceCode} · {fmtTime(p.date)} · {p.commentCount} bình luận đã lưu</span>
              {p.scanStatus === 'FAILED' && <span className="err">Quét bình luận gián đoạn</span>}
              {p.mediaStatus === 'FAILED' && <span className="err">Thiếu ảnh hoặc video</span>}
            </Link>
          ))}
          {(page > 1 || listing.hasMore) && <nav className={styles.pagination} aria-label="Trang danh sách">
            {page > 1 && <Link href={link({ q, page: String(page - 1), trash })}>Trước</Link>}
            <span>Trang {page}</span>
            {listing.hasMore && <Link href={link({ q, page: String(page + 1), trash })}>Tiếp</Link>}
          </nav>}
        </aside>
        <section className={styles.detail} aria-label="Xem trước bài viết">
          {detail ? <>
            <AutoRefresh seconds={detail.scan?.status === 'RUNNING' || detail.scan?.status === 'QUEUED' ? 4 : 20} />
            <PostWorkspace key={`${detail.post.id}:${profile.code}:${requestedTarget ?? ''}`} detail={detail} requestedTarget={requestedTarget}
              canReview={canReview && !detail.post.archivedAt} canOperate={canOperate && !detail.post.archivedAt}
              canArchive={!!source && canReview} />
          </> : <div className={styles.empty}><h2>{postId ? 'Không tìm thấy bài trong hồ sơ này' : 'Chọn một bài để xem chi tiết'}</h2></div>}
        </section>
      </div>
    </div>
  );
}
