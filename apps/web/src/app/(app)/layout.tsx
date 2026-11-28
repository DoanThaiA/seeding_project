import type { ReactNode } from 'react';
import { logout } from '../login/actions';
import { NavGroup, NavLink } from '@/components/client';
import { apiGet, can, getSession } from '@/lib/api';

interface Dash {
  openTasks: Record<string, number>;
}

const ROLE_VI: Record<string, string> = { admin: 'Quản trị', reviewer: 'Người duyệt', operator: 'Vận hành', viewer: 'Chỉ xem' };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  const dash = await apiGet<Dash>('/dashboard', s.token).catch(() => null);
  const t = dash?.openTasks ?? {};
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">SeedingSys</div>
        <nav className="nav" aria-label="Điều hướng chính">
          <NavLink href="/">Tổng quan</NavLink>
          <NavGroup label="Quản lý hồ sơ" items={[
            { href: '/library?kind=A', label: 'Hồ sơ A' },
            { href: '/library?kind=B', label: 'Hồ sơ B' },
            { href: '/profile-sync', label: 'Đồng bộ hồ sơ' },
            ...(can.admin(s.role) ? [{ href: '/settings', label: 'Quản trị luồng' }] : []),
          ]} />
          <NavLink href="/comment-scripts">Kịch bản bình luận</NavLink>
          <NavGroup label="Quản trị bài đăng" items={[
            { href: '/schedule', label: 'Lịch và bài chờ' },
            { href: '/review', label: 'Duyệt bài', count: t.REVIEW_CONTENT, warn: true },
            { href: '/tasks', label: 'Cần xử lý', count: (t.TAKEOVER_ACCOUNT ?? 0) + (t.CONFIRM_RESULT ?? 0) },
          ]} />
          <NavLink href="/reports">Báo cáo</NavLink>
          <details className="nav-more">
            <summary>Thao tác khác</summary>
            <NavLink href="/publications">Bài đã đăng</NavLink>
            {(can.review(s.role) || can.operate(s.role)) && <NavLink href="/import">Nhập bài</NavLink>}
            <NavLink href="/controls">Công tắc dừng</NavLink>
          </details>
        </nav>
        <div className="who">
          <div>{ROLE_VI[s.role] ?? s.role}</div>
          <form action={logout}>
            <button type="submit" className="sm">Đăng xuất</button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
