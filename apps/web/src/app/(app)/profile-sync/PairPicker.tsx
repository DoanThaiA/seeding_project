'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { Profile } from '../library/types';
import styles from './profile-sync.module.css';

export interface PairOption {
  id: string;
  source: Profile;
  target: Profile;
}

export function PairPicker({ pairs, selectedId }: { pairs: PairOption[]; selectedId?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <label className={styles.picker}>
    <span>Luồng cần đồng bộ</span>
    <select value={selectedId ?? ''} aria-busy={pending} disabled={pending} onChange={event => {
      const pair = pairs.find(item => item.id === event.target.value);
      if (!pair) return;
      const query = new URLSearchParams({ source: pair.source.code, target: pair.target.code });
      start(() => router.push(`/profile-sync?${query}`));
    }}>
      {!selectedId && <option value="" disabled>Chọn luồng A → B</option>}
      {pairs.map(pair => <option key={pair.id} value={pair.id}>
        {pair.source.code} · {pair.source.name} → {pair.target.code} · {pair.target.name}
      </option>)}
    </select>
  </label>;
}
