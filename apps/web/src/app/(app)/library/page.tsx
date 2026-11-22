import Link from 'next/link';
import { ApiError, apiGet, can, getSession } from '@/lib/api';
import { ActionButton, AutoRefresh } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime, reasonText } from '@/lib/format';
import { PostWorkspace } from './PostWorkspace';
import { ProfileSyncPanel } from './ProfileSyncPanel';
import type { Listing, PostDetail, Profiles, ProfileSyncOption } from './types';
import styles from './library.module.css';

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
  const profile = choices.find(p => p.code === read('profile')) ?? choices[0];
  if (!profile) return <><h1>Kho bài viết</h1><p>Thêm profile nguồn hoặc đích trong Quản trị luồng đăng để xem bài tại đây.</p></>;
  const q = (read('q') ?? '').slice(0, 120);
  const trash = read('trash') === '1' ? '1' : undefined;
  const page = Math.max(1, Math.min(2000, Number.parseInt(read('page') ?? '1', 10) || 1));
  const postId = read('post');
  const query = new URLSearchParams({ page: String(page), q, ...(trash && { trash }) });
  const [listing, syncs] = await Promise.all([
    apiGet<Listing>(`/library/profiles/${encodeURIComponent(profile.code)}?` + query, session.token),
    profiles.sources.some(s => s.id === profile.id) ? apiGet<ProfileSyncOption[]>(`/library/profiles/${encodeURIComponent(profile.code)}/syncs`, session.token) : [],
  ]);
  const chosen = listing.posts.find(p => p.id === postId);
  const detail = chosen ? await apiGet<PostDetail>('/library/posts/' + chosen.id, session.token).catch(error => {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return null;
  }) : null;
  const s = profiles.sources.find(item => item.code === profile.code);
  const canReview = can.review(session.role);
  const canOperate = can.operate(session.role);

  return (
    <div className={styles.workspace}>
      <header className={styles.heading}>
        <div><h1>Kho bài viết</h1><p className="muted">Xem bài đã thu thập, bản chờ đăng và bài đã đăng theo profile.</p></div>
        {s?.enabled && can.admin(session.role) && <ActionButton path={`sources/${s.id}/poll`}>Quét bài của {s.code}</ActionButton>}
      </header>
      <nav className={styles.profileBar} aria-label="Profile bài viết">
        <div><span>Nguồn</span>{profiles.sources.map(p => <Link key={p.id} href={href({ profile: p.code })}
          aria-current={p.id === profile.id ? 'page' : undefined} title={p.name}><strong>{p.code}</strong><small>{p._count.posts}</small></Link>)}</div>
        <div><span>Đích</span>{profiles.targets.map(p => <Link key={p.id} href={href({ profile: p.code })}
          aria-current={p.id === profile.id ? 'page' : undefined} title={p.name}><strong>{p.code}</strong><small>{p._count.publications} đã đăng</small></Link>)}</div>
      </nav>
      {s && !trash && <ProfileSyncPanel key={s.id} code={s.code} connector={s.connector} enabled={s.enabled} options={syncs} canOperate={canOperate} canReview={canReview} />}
      {(syncs.some(o => o.latest && ['DISCOVERING','PREPARING'].includes(o.latest.phase)) ||
        syncs.some(o => (o.latest?.stats?.scansPending ?? 0) > 0)) && <AutoRefresh seconds={5} />}
      <div className={styles.body}>
        <aside className={styles.list}>
          <div className={styles.listHeading}><strong>{profile.code} · {profile.name}</strong> <Badge s={profile.enabled ? 'OK' : 'PAUSED'} /></div>
          {s && <div className={styles.trashNav}>
            <Link href={href({ profile: profile.code })} aria-current={!trash ? 'page' : undefined}>Bài trong kho</Link>
            <Link href={href({ profile: profile.code, trash: '1' })} aria-current={trash ? 'page' : undefined}>Thùng rác</Link>
          </div>}
          {s && <p className="muted">
            {s.lastSuccessAt ? `Lưu kết quả quét ${fmtTime(s.lastSuccessAt)}` : 'Chưa có lượt quét thành công'}
            {!!s.lastIncomplete?.length && <><br />{s.lastIncomplete.map(reasonText).join(' · ')}</>}
            {s.lastError && <><br /><span className="err">{s.lastError}</span></>}
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
              aria-current={chosen?.id === p.id ? 'page' : undefined}>
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
            <PostWorkspace key={detail.post.id + ':' + profile.code} detail={detail} requestedTarget={listing.kind === 'target' ? profile.code : read('to')}
              canReview={canReview && !detail.post.archivedAt} canOperate={canOperate && !detail.post.archivedAt}
              canArchive={!!s && canReview} />
          </> : <div className={styles.empty}><h2>Chọn một bài để xem trước</h2><p>Caption, ảnh, video và cây bình luận của bài sẽ hiện ở đây.</p></div>}
        </section>
      </div>
    </div>
  );
}
