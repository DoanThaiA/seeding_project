import Link from 'next/link';
import { ApiError, apiGet, can, getSession } from '@/lib/api';
import { ActionButton, AutoRefresh } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime, reasonText } from '@/lib/format';
import { SUCCESS } from '@seedingsys/contracts';
import { PostWorkspace } from './PostWorkspace';
import { ProfilePicker } from './ProfilePicker';
import type { Listing, PostDetail, Profiles } from './types';
import styles from './library.module.css';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function href(query: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
  return '/library?' + search.toString();
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  const input = await searchParams;
  const read = (key: string) => typeof input[key] === 'string' ? input[key] : undefined;
  const profiles = await apiGet<Profiles>('/library/profiles', session.token);
  const choices = [...profiles.sources, ...profiles.targets];
  const profile = choices.find(p => p.code === read('profile')?.toUpperCase()) ?? choices[0];
  if (!profile) return <><h1>Hồ sơ A và B</h1><p>Chưa có hồ sơ nguồn hoặc đích.</p>
    {can.admin(session.role) && <Link href="/settings">Mở Quản trị luồng đăng</Link>}</>;
  const q = (read('q') ?? '').slice(0, 120);
  const trash = read('trash') === '1' ? '1' : undefined;
  const page = Math.max(1, Math.min(2000, Number.parseInt(read('page') ?? '1', 10) || 1));
  const postId = read('post')?.toLowerCase();
  const query = new URLSearchParams({ page: String(page), q, ...(trash && { trash }) });
  const [listing, candidate] = await Promise.all([
    apiGet<Listing>(`/library/profiles/${encodeURIComponent(profile.code)}?` + query, session.token),
    postId && UUID.test(postId) ? apiGet<PostDetail>('/library/posts/' + postId, session.token).catch(error => {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return null;
    }) : null,
  ]);
  const source = profiles.sources.find(item => item.id === profile.id);
  const target = profiles.targets.find(item => item.id === profile.id);
  const belongsToProfile = candidate && (source
    ? candidate.source.id === profile.id && !!candidate.post.archivedAt === !!trash
    : candidate.destinations.some(destination => destination.target.id === profile.id && (destination.variant || destination.publication)
      && (!candidate.post.archivedAt || (!!destination.publication && SUCCESS.includes(destination.publication.status)))));
  const detail = belongsToProfile ? candidate : null;
  const requestedTarget = listing.kind === 'target' ? profile.code : read('to');
  const canReview = can.review(session.role);
  const canOperate = can.operate(session.role);

  return (
    <div className={styles.workspace}>
      <header className={styles.heading}>
        <h1>Hồ sơ A và B</h1>
        <ProfilePicker profiles={profiles} selected={profile.code} />
      </header>
      <section className={styles.profileBar} aria-label="Thông tin hồ sơ">
        <div>
          <Badge s={profile.enabled ? 'OK' : 'PAUSED'} text={profile.enabled ? 'Đang bật' : 'Đã tắt'} />
          <strong>{profile.code} · {profile.name}</strong>
          <span className="muted">{source ? `${source._count.posts} bài đã lưu` : `${target?._count.publications ?? 0} bài đã đăng`}</span>
        </div>
        <div className="actions">
          {source?.enabled && can.admin(session.role) && <ActionButton path={`sources/${source.id}/poll`}>Quét bài của {source.code}</ActionButton>}
          <Link className="btn" href={{ pathname: '/profile-sync', query: source ? { source: profile.code } : { target: profile.code } }}>Đồng bộ hồ sơ</Link>
        </div>
      </section>
      <div className={styles.body}>
        <aside className={styles.list}>
          <div className={styles.listHeading}><strong>{source ? 'Bài nguồn' : 'Bài của tài khoản đích'}</strong></div>
          {source && <div className={styles.trashNav}>
            <Link href={href({ profile: profile.code })} aria-current={!trash ? 'page' : undefined}>Bài trong kho</Link>
            <Link href={href({ profile: profile.code, trash: '1' })} aria-current={trash ? 'page' : undefined}>Thùng rác</Link>
          </div>}
          {source && <p className="muted">
            {source.lastSuccessAt ? `Quét lần cuối ${fmtTime(source.lastSuccessAt)}` : 'Chưa có lượt quét thành công'}
            {!!source.lastIncomplete?.length && <><br />{source.lastIncomplete.map(reasonText).join(' · ')}</>}
            {source.lastError && <><br /><span className="err">{source.lastError}</span></>}
          </p>}
          {listing.kind === 'target' && <p className="muted">Các bài do SeedingSys theo dõi cho {profile.code}.</p>}
          <form action="/library" className={styles.search}>
            <input type="hidden" name="profile" value={profile.code} />
            {trash && <input type="hidden" name="trash" value={trash} />}
            <input name="q" defaultValue={q} maxLength={120} placeholder="Tìm theo caption" aria-label="Tìm theo caption" />
            <button className="sm" type="submit">Tìm</button>
          </form>
          {!listing.posts.length && <p className="muted">{q ? 'Không tìm thấy bài phù hợp.' : trash ? 'Thùng rác trống.' : 'Profile này chưa có bài trong kho.'}</p>}
          {listing.posts.map(p => (
            <Link className={styles.listItem} key={p.id} href={href({ profile: profile.code, q, page: String(page), post: p.id, trash })}
              aria-current={detail?.post.id === p.id ? 'page' : undefined}>
              <div><Badge s={p.contentType} /> {p.archivedAt ? <Badge s="CANCELLED" text="Trong thùng rác" /> : <Badge s={p.status} />}</div>
              <strong>{p.snippet || 'Bài không có caption'}</strong>
              <span>{p.sourceCode} · {fmtTime(p.date)} · {p.commentCount} bình luận đã lưu</span>
              {p.scanStatus === 'FAILED' && <span className="err">Quét bình luận gián đoạn</span>}
              {p.mediaStatus === 'FAILED' && <span className="err">Thiếu ảnh hoặc video</span>}
            </Link>
          ))}
          {(page > 1 || listing.hasMore) && <nav className={styles.pagination} aria-label="Trang danh sách">
            {page > 1 && <Link href={href({ profile: profile.code, q, page: String(page - 1), trash })}>Trước</Link>}
            <span>Trang {page}</span>
            {listing.hasMore && <Link href={href({ profile: profile.code, q, page: String(page + 1), trash })}>Tiếp</Link>}
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
