import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
export const COOKIE = 'ss_token';

export type Role = 'admin' | 'reviewer' | 'operator' | 'viewer';
export interface Session {
  token: string;
  role: Role;
  actor: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Server-side call to the SeedingSys API with the signed-in user's token. */
export async function apiGet<T>(path: string, token?: string): Promise<T> {
  const t = token ?? (await cookies()).get(COOKIE)?.value;
  if (!t) redirect('/login');
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' });
  } catch {
    throw new ApiError(0, `Không kết nối được API (${API_URL}). Kiểm tra dịch vụ api đã chạy chưa.`);
  }
  if (res.status === 401) redirect('/login?expired=1');
  if (!res.ok) {
    const message = res.status >= 500 ? 'Dịch vụ API đang gián đoạn.' : 'API từ chối yêu cầu.';
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Current session (role comes from the API, never trusted from the browser). */
export async function getSession(): Promise<Session> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) redirect('/login');
  const me = await apiGet<{ role: Role; actor: string }>('/me', token);
  return { token, role: me.role, actor: me.actor };
}

export const can = {
  review: (r: Role) => r === 'admin' || r === 'reviewer',
  operate: (r: Role) => r === 'admin' || r === 'operator',
  admin: (r: Role) => r === 'admin',
};
