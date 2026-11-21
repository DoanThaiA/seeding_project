import { AutoRefresh } from '@/components/client';
import { Empty, Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ReviewCard, type ReviewItem } from './ReviewCard';

export default async function ReviewPage() {
  const s = await getSession();
  const items = await apiGet<ReviewItem[]>('/review', s.token);
  return (
    <>
      <AutoRefresh seconds={20} />
      <Head title="Duyệt bài" sub="Bài bị giữ lại vì chế độ duyệt tay, nguồn chưa đầy đủ, media lỗi hoặc caption chưa đạt kiểm tra. Cũ nhất ở trên." />
      {!can.review(s.role) && <div className="alert warn" style={{ marginBottom: 12 }}>Tài khoản của bạn chỉ có quyền xem — không duyệt được.</div>}
      {items.length === 0 ? (
        <div className="card"><Empty>Không có bài nào đang chờ duyệt.</Empty></div>
      ) : (
        items.map((v) => <ReviewCard key={v.id} v={v} canAct={can.review(s.role)} />)
      )}
    </>
  );
}
