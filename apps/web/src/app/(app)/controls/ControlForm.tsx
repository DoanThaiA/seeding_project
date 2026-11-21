'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';

type Scope = 'GLOBAL' | 'SOURCE' | 'TARGET' | 'FORMAT' | 'CONNECTOR';
type Opt = { value: string; label: string };

export function ControlForm({ options }: { options: Record<'SOURCE' | 'TARGET' | 'FORMAT' | 'CONNECTOR', Opt[]> }) {
  const [scope, setScope] = useState<Scope>('TARGET');
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const s = useSubmit();
  const list = scope === 'GLOBAL' ? [] : options[scope];
  const scopeKey = scope === 'GLOBAL' ? '*' : key || list[0]?.value || '';
  return (
    <div>
      <div className="row">
        <div className="field">
          <label htmlFor="sc">Phạm vi</label>
          <select id="sc" value={scope} onChange={(e) => { setScope(e.target.value as Scope); setKey(''); }}>
            <option value="TARGET">Một tài khoản đích</option>
            <option value="SOURCE">Một nguồn</option>
            <option value="FORMAT">Một định dạng</option>
            <option value="CONNECTOR">Một connector</option>
            <option value="GLOBAL">Toàn hệ thống</option>
          </select>
        </div>
        {scope !== 'GLOBAL' && (
          <div className="field">
            <label htmlFor="ky">Đối tượng</label>
            <select id="ky" value={scopeKey} onChange={(e) => setKey(e.target.value)}>
              {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="field" style={{ flexBasis: 280 }}>
          <label htmlFor="rs">Lý do (bắt buộc)</label>
          <input id="rs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Facebook đổi giao diện, tạm dừng video" />
        </div>
        <button
          className="danger"
          disabled={s.pending || reason.trim().length < 3 || !scopeKey}
          onClick={() => {
            if (scope === 'GLOBAL' && !window.confirm('Dừng TOÀN BỘ hệ thống? Mọi thu thập và đăng mới sẽ dừng.')) return;
            s.run(() => bff('PUT', 'controls', { scope, scopeKey, paused: true, reason: reason.trim() }), 'Đã bật công tắc dừng');
          }}
        >
          Dừng
        </button>
      </div>
      {s.error && <p className="err" role="alert">{s.error}</p>}
      {s.done && <p className="okmsg">{s.done}</p>}
    </div>
  );
}

export function ResumeButton({ scope, scopeKey }: { scope: Scope; scopeKey: string }) {
  const s = useSubmit();
  return (
    <span>
      <button
        className="sm"
        disabled={s.pending}
        onClick={() => {
          const why = window.prompt('Lý do bật lại (bắt buộc):');
          if (why && why.trim().length >= 3) s.run(() => bff('PUT', 'controls', { scope, scopeKey, paused: false, reason: why.trim() }), 'Đã bật lại');
        }}
      >
        Bật lại
      </button>
      {s.error && <span className="err"> {s.error}</span>}
    </span>
  );
}
