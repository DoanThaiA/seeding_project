'use client';

import type { ProfileDetailsSnapshot, SyncedProfileDetails } from '@seedingsys/contracts';
import { ActionButton } from '@/components/client';
import { ProfileDetailsView } from '@/components/ProfileDetailsView';
import { fmtTime } from '@/lib/format';
import styles from './profile-sync.module.css';

export interface ProfileDetailsState {
  scan: { requestId: string; status: string; error: string | null; snapshot: ProfileDetailsSnapshot | null;
    bioStatus: string; bioError: string | null } | null;
  synced: SyncedProfileDetails | null;
  canApplyBio: boolean;
}

const scanLabel: Record<string, string> = { QUEUED: 'Đang chờ quét', READING: 'Đang đọc trang Facebook', READY: 'Đã lưu bản quét', FAILED: 'Lượt quét gián đoạn' };
const bioLabel: Record<string, string> = { QUEUED: 'Đang chờ cập nhật tiểu sử', RUNNING: 'Đang mở hồ sơ Facebook',
  COMMITTING: 'Đang xác minh tiểu sử đã lưu', DONE: 'Đã xác minh tiểu sử trên Facebook', FAILED: 'Chưa cập nhật được tiểu sử', NEEDS_CHECK: 'Cần đối chiếu tiểu sử trên Facebook' };

export function ProfileDetailsPanel({ mappingId, source, target, state, heading = 'Thông tin hồ sơ', showSaved = true, showFacebookActions = true }: {
  mappingId: string; source: string; target: string; state: ProfileDetailsState; heading?: string; showSaved?: boolean; showFacebookActions?: boolean;
}) {
  const { scan, synced, canApplyBio } = state;
  const scanning = scan?.status === 'QUEUED' || scan?.status === 'READING';
  const updating = ['QUEUED', 'RUNNING', 'COMMITTING'].includes(scan?.bioStatus ?? '');
  const saved = !!scan && synced?.requestId === scan.requestId;
  return <section className={styles.panel} aria-labelledby="profile-details-heading">
    <header className={styles.panelHeading}>
      <h2 id="profile-details-heading">{heading}</h2>
      <ActionButton className="primary" path={`profile-details/${mappingId}/scan`} disabled={scanning || updating}>
        {`Quét ${source} và lưu vào ${target}`}
      </ActionButton>
    </header>
    {scan && <p role="status">{scan.status === 'READY' && saved ? `Đã lưu thông tin ${source} vào ${target}` : scanLabel[scan.status]}
      {scan.snapshot && ` · ${fmtTime(scan.snapshot.capturedAt)}`}</p>}
    {scan?.error && <p className="err" role="alert">{scan.error}</p>}
    {scan?.status === 'READY' && scan.snapshot && <>
      {(!saved || showSaved) && <ProfileDetailsView snapshot={scan.snapshot} />}
      {showFacebookActions && <>
        {scan.snapshot.bio && canApplyBio && <div className="actions"><ActionButton path={`profile-details/${mappingId}/sync`}
          body={{ requestId: scan.requestId, applyBio: true }} disabled={updating || (scan.bioStatus === 'DONE' && saved)}
          confirm={`Lưu thông tin ${source} vào hệ thống và cập nhật tiểu sử Facebook của ${target} theo bản quét này?`}>
          {scan.bioStatus === 'NEEDS_CHECK' ? 'Đối chiếu và cập nhật lại tiểu sử' : 'Cập nhật tiểu sử trên Facebook'}
        </ActionButton></div>}
        {bioLabel[scan.bioStatus] && <p role="status">{bioLabel[scan.bioStatus]}</p>}
        {scan.bioError && <p className="err" role="alert">{scan.bioError}</p>}
      </>}
    </>}
    {showSaved && synced && !saved && <details>
      <summary>Bản đang lưu ở {target} từ {synced.sourceCode} · {fmtTime(synced.syncedAt)}</summary>
      <ProfileDetailsView snapshot={synced.snapshot} />
    </details>}
  </section>;
}
