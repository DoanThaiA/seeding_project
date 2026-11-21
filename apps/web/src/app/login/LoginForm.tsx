'use client';

import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="token">Mã truy cập</label>
        <input id="token" name="token" type="password" autoComplete="current-password" autoFocus required />
      </div>
      <button className="primary" type="submit" disabled={pending} style={{ width: '100%' }}>
        {pending ? 'Đang kiểm tra…' : 'Đăng nhập'}
      </button>
      {state?.error && <p className="err" role="alert">{state.error}</p>}
    </form>
  );
}
