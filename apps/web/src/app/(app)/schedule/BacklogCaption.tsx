'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';

const audienceLabels: Record<string, string> = { ONLY_ME: 'Chỉ mình tôi', FRIENDS: 'Bạn bè', PUBLIC: 'Công khai' };

export function BacklogCaption({ id, value, snapshotHash, optional, audience }: { id: string; value: string; snapshotHash: string; optional: boolean; audience?: string }) {
  const [caption, setCaption] = useState(value);
  const s = useSubmit();
  return (
    <details>
      <summary>{audience ? 'Sửa caption hoặc quyền xem' : 'Sửa caption'}</summary>
      <form onSubmit={e => { e.preventDefault(); s.run(() => bff('PATCH', 'backlog/' + id, { caption, snapshotHash })); }}>
        <label htmlFor={'backlog-caption-' + id}>Caption sẽ đăng</label>
        <textarea id={'backlog-caption-' + id} value={caption} onChange={e => setCaption(e.target.value)} required={!optional} maxLength={5000} />
        <button type="submit" className="sm" disabled={s.pending || (!optional && !caption.trim()) || caption.trim() === value}>Lưu caption</button>
        {audience && <button type="button" className="sm" disabled={s.pending || (!optional && !caption.trim())}
          onClick={() => s.run(() => bff('PATCH', 'backlog/' + id, { caption, snapshotHash, audience }))}>
          Xác nhận quyền xem {audienceLabels[audience] ?? audience}
        </button>}
        {s.error && <p className="err" role="alert">{s.error}</p>}
        {s.done && <p className="okmsg" role="status">{s.done}</p>}
      </form>
    </details>
  );
}
