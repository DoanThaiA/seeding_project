import { NextRequest, NextResponse } from 'next/server';
import { API_URL, COOKIE } from '@/lib/api';

/**
 * Browser → API proxy. The API token lives in an httpOnly cookie and is attached here, so page
 * scripts never see it. Non-GET calls must carry the custom header (cheap CSRF guard on top of
 * SameSite=Lax).
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return NextResponse.json({ message: 'Chưa đăng nhập' }, { status: 401 });
  if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'seedingsys') {
    return NextResponse.json({ message: 'Yêu cầu không hợp lệ' }, { status: 403 });
  }
  const { path } = await ctx.params;
  const url = `${API_URL}/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const range = req.method === 'GET' ? req.headers.get('range') : null;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}), ...(hasBody ? { 'Content-Type': req.headers.get('content-type') ?? 'application/json' } : {}) },
      // Raw bytes: JSON bodies and multipart uploads (manual import) pass through unchanged.
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ message: 'Không kết nối được API' }, { status: 502 });
  }
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition', 'cache-control', 'accept-ranges', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
