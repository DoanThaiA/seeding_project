import { redirect } from 'next/navigation';

// Phần "Quản lý nhân vật" đã gộp vào Hồ sơ B; giữ route cũ để link cũ không chết.
export default function PersonasPage() {
  redirect('/library?kind=B');
}
