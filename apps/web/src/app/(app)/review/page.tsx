import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty, Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { needsPublishChoice } from '@seedingsys/contracts';
import { ReviewCard, type ReviewItem } from './ReviewCard';
import styles from './review.module.css';

const PAGE_SIZE = 20;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ source?: string; target?: string; variant?: string; page?: string }> }) {
  const query = await searchParams;
  const s = await getSession();
  const items = await apiGet<ReviewItem[]>('/review', s.token);
  const codes = (getCode: (item: ReviewItem) => string) =>
    [...new Set(items.map(getCode))].sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  const sources = codes(item => item.revision.post.source.code);
  const targets = codes(item => item.target.code);
  const source = sources.includes(query.source ?? '') ? query.source : undefined;
  const target = targets.includes(query.target ?? '') ? query.target : undefined;
  const matching = items.filter(item => (!source || item.revision.post.source.code === source) && (!target || item.target.code === target));
  const chosen = matching.findIndex(item => item.id === query.variant);
  const maxPage = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const requestedPage = Number(query.page);
  const page = chosen >= 0 ? Math.floor(chosen / PAGE_SIZE) + 1
    : Number.isInteger(requestedPage) ? Math.max(1, Math.min(maxPage, requestedPage)) : 1;
  const rows = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = chosen >= 0 ? matching[chosen] : rows[0];
  const href = (page: number, variant?: string) => ({ pathname: '/review', query: { source, target, page: String(page), variant } });

  return (
    <>
      <AutoRefresh seconds={20} />
      <Head title="Duyệt bài" sub={items.length ? `${items.length} bài đang chờ duyệt` : undefined} />
      {!can.review(s.role) && <p className="alert warn">Tài khoản của bạn có quyền xem.</p>}
      {items.length > 0 && (
        <form className={styles.filters} method="get" key={`${source ?? ''}-${target ?? ''}`}>
          <label>Nguồn A<select name="source" defaultValue={source ?? ''}>
            <option value="">Tất cả nguồn</option>
            {sources.map(code => <option key={code}>{code}</option>)}
          </select></label>
          <label>Đích B<select name="target" defaultValue={target ?? ''}>
            <option value="">Tất cả đích</option>
            {targets.map(code => <option key={code}>{code}</option>)}
          </select></label>
          <button type="submit">Lọc</button>
          {(source || target) && <Link href="/review">Bỏ lọc</Link>}
        </form>
      )}
      {!selected ? (
        <div className="card"><Empty>{items.length ? 'Không có bài trong bộ lọc này.' : 'Không có bài đang chờ duyệt.'}</Empty></div>
      ) : (
        <div className={styles.workspace}>
          <nav className={styles.queue} aria-label="Danh sách bài chờ duyệt">
            <h2>{matching.length} bài</h2>
            {rows.map(item => (
              <Link key={item.id} href={href(page, item.id)} scroll={false}
                className={styles.item} aria-current={item.id === selected.id ? 'page' : undefined}>
                <span>{item.revision.post.source.code} → {item.target.code} {!needsPublishChoice(item.contentType) && <Badge s={item.contentType} />}</span>
                <strong>{item.revision.text || item.caption || 'Bài không có caption'}</strong>
                <small>{fmtTime(item.createdAt)}</small>
              </Link>
            ))}
            {maxPage > 1 && <div className={styles.pagination}>
              {page > 1 && <Link href={href(page - 1)}>Trang trước</Link>}
              <span>Trang {page}/{maxPage}</span>
              {page < maxPage && <Link href={href(page + 1)}>Trang sau</Link>}
            </div>}
          </nav>
          <ReviewCard key={selected.id} v={selected} canAct={can.review(s.role)} />
        </div>
      )}
    </>
  );
}
