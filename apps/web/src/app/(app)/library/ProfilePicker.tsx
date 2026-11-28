'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { Profiles } from './types';
import styles from './library.module.css';

/** `kind` limits the list to one side (the sidebar entries "Hồ sơ A" / "Hồ sơ B") and is kept in the URL. */
export function ProfilePicker({ profiles, selected, kind }: { profiles: Profiles; selected: string; kind?: 'A' | 'B' }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <div className={styles.profilePicker}>
    <label htmlFor="library-profile">Hồ sơ</label>
    <select id="library-profile" value={selected} disabled={pending} aria-busy={pending} onChange={event => {
      const query = new URLSearchParams({ profile: event.target.value, ...(kind && { kind }) });
      start(() => router.push(`/library?${query}`));
    }}>
      {kind !== 'B' && !!profiles.sources.length && <optgroup label="A · Hồ sơ nguồn">
        {profiles.sources.map(profile => <option key={profile.id} value={profile.code}>{profile.code} · {profile.name} ({profile._count.posts} bài)</option>)}
      </optgroup>}
      {kind !== 'A' && !!profiles.targets.length && <optgroup label="B · Hồ sơ đích">
        {profiles.targets.map(profile => <option key={profile.id} value={profile.code}>{profile.code} · {profile.name} ({profile._count.publications} đã đăng)</option>)}
      </optgroup>}
    </select>
  </div>;
}
