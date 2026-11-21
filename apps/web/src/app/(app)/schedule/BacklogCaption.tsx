'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';

export function BacklogCaption({ id, value, snapshotHash }: { id: string; value: string; snapshotHash: string }) {
  const [caption, setCaption] = useState(value);
  const s = useSubmit();
  return (
    <details>
      <summary>Sửa caption</summary>
      <form onSubmit={e => { e.preventDefault(); s.run(() => bff('PATCH', 'backlog/' + id, { caption, snapshotHash })); }}>
        <label htmlFor={'backlog-caption-' + id}>Caption sẽ đăng</label>
        <textarea id={'backlog-caption-' + id} value={caption} onChange={e => setCaption(e.target.value)} required maxLength={5000} />
        <button type="submit" className="sm" disabled={s.pending || !caption.trim() || caption.trim() === value}>Lưu caption</button>
        {s.error && <p className="err" role="alert">{s.error}</p>}
        {s.done && <p className="okmsg" role="status">{s.done}</p>}
      </form>
    </details>
  );
}
