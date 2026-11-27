import type { ReactNode } from 'react';
import { logout } from '../login/actions';
import { NavLink } from '@/components/client';
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
          <NavLink href="/library">Hồ sơ A &amp; B</NavLink>
          <NavLink href="/profile-sync">Đồng bộ hồ sơ</NavLink>
          <NavLink href="/profile-groups">Nhóm hồ sơ</NavLink>
          <NavLink href="/comment-scripts">Kịch bản bình luận</NavLink>
          <NavLink href="/schedule">Lịch &amp; bài chờ</NavLink>
          <NavLink href="/review" count={t.REVIEW_CONTENT} warn>Duyệt bài</NavLink>
          <NavLink href="/tasks" count={(t.TAKEOVER_ACCOUNT ?? 0) + (t.CONFIRM_RESULT ?? 0)}>Cần xử lý</NavLink>
          {can.admin(s.role) && <NavLink href="/settings">Quản trị luồng</NavLink>}
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
