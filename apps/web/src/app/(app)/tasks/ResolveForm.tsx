'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';

export function ResolveForm({ id }: { id: string }) {
  const [note, setNote] = useState('');
  const [resume, setResume] = useState(true);
  const s = useSubmit();
  return (
    <div>
      <div className="row">
        <div className="field" style={{ flexBasis: 320 }}>
          <label htmlFor={`n-${id}`}>Đã làm gì (bắt buộc)</label>
          <input id={`n-${id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: đã đăng nhập lại và xác minh bằng SMS" />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, color: 'var(--text)' }}>
          <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} style={{ width: 'auto' }} />
          Bật lại tài khoản
        </label>
        <button className="primary" disabled={s.pending || note.trim().length < 3} onClick={() => s.run(() => bff('POST', `operator-tasks/${id}/resolve`, { note: note.trim(), resumeAccount: resume }), 'Đã đóng việc')}>
          Đã xử lý
        </button>
      </div>
      {s.error && <p className="err" role="alert">{s.error}</p>}
    </div>
  );
}
