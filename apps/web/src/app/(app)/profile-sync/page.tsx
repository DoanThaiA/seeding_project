import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import type { Profiles, ProfileSyncOption } from '../library/types';
import { ProfileArtworkPanel, type ProfileArtworkView } from '../settings/ProfileArtworkPanel';
import { PairPicker } from './PairPicker';
import { ProfileSyncPanel } from './ProfileSyncPanel';
import { ProfileDetailsPanel, type ProfileDetailsState } from './ProfileDetailsPanel';
import styles from './profile-sync.module.css';

type Mapping = { id: string; sourceId: string; targetId: string; enabled: boolean };
type ArtworkTarget = { id: string; connector: string; externalId: string };

export default async function ProfileSyncPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  const [query, profiles, mappings] = await Promise.all([
    searchParams,
    apiGet<Profiles>('/library/profiles', session.token),
    apiGet<Mapping[]>('/mappings', session.token),
  ]);
  const requestedSource = typeof query.source === 'string' ? query.source.toUpperCase() : undefined;
  const requestedTarget = typeof query.target === 'string' ? query.target.toUpperCase() : undefined;
  const sources = new Map(profiles.sources.map(source => [source.id, source]));
  const targets = new Map(profiles.targets.map(target => [target.id, target]));
  const pairs = mappings.flatMap(mapping => {
    const source = sources.get(mapping.sourceId);
    const target = targets.get(mapping.targetId);
    return mapping.enabled && source && target ? [{ id: mapping.id, source, target }] : [];
  }).sort((a, b) => a.source.code.localeCompare(b.source.code, 'vi', { numeric: true })
    || a.target.code.localeCompare(b.target.code, 'vi', { numeric: true }));
  const pair = pairs.find(item => (!requestedSource || item.source.code === requestedSource) && (!requestedTarget || item.target.code === requestedTarget));
  const artworkAllowed = !!pair && can.admin(session.role) && ['fb-public', 'fb-session'].includes(pair.source.connector);
  const [syncs, artworkTargets, artworks, details] = await Promise.all([
    pair ? apiGet<ProfileSyncOption[]>(`/library/profiles/${encodeURIComponent(pair.source.code)}/syncs`, session.token) : [],
    artworkAllowed ? apiGet<ArtworkTarget[]>('/targets', session.token) : [],
    artworkAllowed ? apiGet<ProfileArtworkView[]>('/profile-artwork', session.token) : [],
    artworkAllowed ? apiGet<ProfileDetailsState>(`/profile-details/${pair.id}`, session.token) : null,
  ]);
  const option = syncs.find(item => item.target.id === pair?.target.id);
  const artworkTarget = artworkTargets.find(item => item.id === pair?.target.id && item.connector === 'fb-web');
  const artwork = artworks.find(item => item.mappingId === pair?.id);
  const latest = option?.latest;
  const stats = latest?.stats;
  const running = latest?.phase === 'DISCOVERING' || latest?.phase === 'PREPARING'
    || (stats && stats.waiting + stats.working + stats.needsCheck + stats.scansPending > 0)
    || ['QUEUED', 'READING'].includes(artwork?.status ?? '')
    || ['QUEUED', 'RUNNING', 'COMMITTING'].includes(artwork?.apply?.status ?? '');
  const updatingDetails = ['QUEUED', 'READING'].includes(details?.scan?.status ?? '')
    || ['QUEUED', 'RUNNING', 'COMMITTING'].includes(details?.scan?.bioStatus ?? '');

  return <div className={styles.workspace}>
    {(running || updatingDetails) && <AutoRefresh seconds={5} />}
    <header className={styles.pageHeading}>
      <h1>Đồng bộ hồ sơ</h1>
      {pairs.length > 0 && <PairPicker pairs={pairs} selectedId={pair?.id} />}
    </header>
    {pair && option ? <>
      <section className={styles.accounts} aria-label="Hồ sơ đang chọn">
        <div><span>Nguồn</span><Link href={{ pathname: '/library', query: { profile: pair.source.code } }}><strong>{pair.source.code}</strong> · {pair.source.name}</Link>
          <Badge s={pair.source.enabled ? 'OK' : 'PAUSED'} text={pair.source.enabled ? 'Đang bật' : 'Đã tắt'} />
          <small>{pair.source._count.posts} bài trong kho</small></div>
        <div><span>Đích</span><Link href={{ pathname: '/library', query: { profile: pair.target.code } }}><strong>{pair.target.code}</strong> · {pair.target.name}</Link>
          <Badge s={pair.target.enabled ? 'OK' : 'PAUSED'} text={pair.target.enabled ? 'Đang bật' : 'Đã tắt'} />
          <small>{pair.target._count.publications} bài đã đăng</small></div>
      </section>
      {artworkTarget && details && <ProfileDetailsPanel key={`details-${pair.id}`} mappingId={pair.id} source={pair.source.code}
        target={pair.target.code} state={details} />}
      <ProfileSyncPanel key={`posts-${pair.id}`} code={pair.source.code} connector={pair.source.connector} enabled={pair.source.enabled} option={option}
        canOperate={can.operate(session.role)} canReview={can.review(session.role)} />
      {artworkTarget && <ProfileArtworkPanel key={`artwork-${pair.id}`} mappingId={pair.id} source={pair.source.code} target={pair.target.code}
        targetExternalId={artworkTarget.externalId} artwork={artwork} />}
    </> : <Empty>
      {pairs.length ? 'Chọn luồng đã bật để đồng bộ hai hồ sơ.' : 'Chưa có luồng nguồn → đích đang bật.'}
      {can.admin(session.role) && <p><Link href="/settings">Mở Quản trị luồng đăng</Link></p>}
    </Empty>}
  </div>;
}
