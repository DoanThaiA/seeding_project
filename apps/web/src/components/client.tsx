'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useTransition, type ReactNode } from 'react';

/** Calls the API through the same-origin proxy. Never throws. */
export async function bff<T = unknown>(method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/bff/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-requested-with': 'seedingsys' },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401) {
      window.location.href = '/login?expired=1';
      return { ok: false, error: 'Phiên đã hết hạn' };
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const m = (data as { message?: string | string[] } | undefined)?.message;
      return { ok: false, error: Array.isArray(m) ? m.join('; ') : (m ?? `Lỗi ${res.status}`) };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: 'Không kết nối được máy chủ' };
  }
}

/** Re-renders the server components every N seconds (dashboard stays live). */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

/** One entry of the sidebar: a path, optionally with the query that identifies it. */
export interface NavItem {
  href: string;
  label: string;
  count?: number;
  warn?: boolean;
}

/** True when `href` (path plus any query it carries) describes the page being shown. */
function navActive(href: string, path: string, search: URLSearchParams): boolean {
  const [base, query] = href.split('?');
  const target = base || '/';
  const samePath = target === '/' ? path === '/' : path === target || path.startsWith(target + '/');
  if (!samePath) return false;
  for (const [key, value] of new URLSearchParams(query ?? '')) if (search.get(key) !== value) return false;
  return true;
}

export function NavLink({ href, children, count, warn }: { href: string; children: ReactNode; count?: number; warn?: boolean }) {
  const path = usePathname();
  const search = useSearchParams();
  const active = navActive(href, path, search);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      <span>{children}</span>
      {count ? <span className={`count ${warn ? 'warn' : ''}`}>{count}</span> : null}
    </Link>
  );
}

/** Collapsible sidebar group: opens itself whenever one of its entries is the current page. */
export function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const path = usePathname();
  const search = useSearchParams();
  const holdsCurrent = items.some(item => navActive(item.href, path, search));
  const [open, setOpen] = useState(holdsCurrent);
  const [known, setKnown] = useState(holdsCurrent);
  if (known !== holdsCurrent) {
    setKnown(holdsCurrent);
    if (holdsCurrent) setOpen(true);
  }
  const pending = items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  return (
    <details className="nav-group" open={open}>
      <summary
        aria-current={holdsCurrent ? 'true' : undefined}
        onClick={event => {
          event.preventDefault();
          setOpen(value => !value);
        }}
      >
        <span>{label}</span>
        {!open && pending ? <span className="count warn">{pending}</span> : null}
      </summary>
      {items.map(item => (
        <NavLink key={item.href} href={item.href} count={item.count} warn={item.warn}>
          {item.label}
        </NavLink>
      ))}
    </details>
  );
}

/** Button that POSTs to the API, optionally asks for confirmation, then refreshes the page data. */
export function ActionButton({
  path,
  method = 'POST',
  body,
  children,
  className = '',
  confirm,
  onDone,
  disabled,
}: {
  path: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  children: ReactNode;
  className?: string;
  confirm?: string;
  onDone?: () => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className={className}
        disabled={pending || disabled}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setErr(null);
          start(async () => {
            const r = await bff(method, path, body);
            if (!r.ok) setErr(r.error);
            else {
              onDone?.();
              router.refresh();
            }
          });
        }}
      >
        {pending ? '…' : children}
      </button>
      {err && <span className="err" role="alert"> {err}</span>}
    </span>
  );
}

/** Small inline form helper: runs `submit`, shows error/success, refreshes. */
export function useSubmit() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<{ ok: true; data?: T } | { ok: false; error: string }>, okText: string | ((data: T | undefined) => string) = 'Đã lưu') => {
    setError(null);
    setDone(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        setDone(typeof okText === 'function' ? okText(r.data) : okText);
        router.refresh();
      }
    });
  };
  return { run, pending, error, done };
}
