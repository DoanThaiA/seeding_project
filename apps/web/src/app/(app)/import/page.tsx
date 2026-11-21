import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ImportForm } from './ImportForm';

interface Source { id: string; code: string; name: string; connector: string; enabled: boolean }

export default async function ImportPage() {
  const s = await getSession();
  if (!can.review(s.role) && !can.operate(s.role)) redirect('/');
  const sources = (await apiGet<Source[]>('/sources', s.token)).filter((x) => x.connector === 'manual' && x.enabled);
  return (
    <>
      <Head title="Nhập bài" sub="Đưa vào hệ thống nội dung mà tổ chức có quyền sử dụng lại. Hệ thống không tự thu thập nội dung từ Facebook." />
      {sources.length === 0 ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>Chưa có nguồn nhập tay nào. Tạo hoặc đổi một nguồn sang connector <strong>manual</strong> ở trang {can.admin(s.role) ? <Link href="/settings">Cấu hình</Link> : 'Cấu hình (cần quản trị viên)'}.</p>
        </div>
      ) : (
        <ImportForm sources={sources.map((x) => ({ id: x.id, label: `${x.code} · ${x.name}` }))} />
      )}
    </>
  );
}
