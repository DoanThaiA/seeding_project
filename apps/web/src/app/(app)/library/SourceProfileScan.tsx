import type { ProfileDetailsSnapshot } from '@seedingsys/contracts';
import { ProfileDetailsView } from '@/components/ProfileDetailsView';
import { Badge } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import styles from './library.module.css';

const statusLabel = {
  PROFILE: 'Đang quét thông tin và ảnh hồ sơ',
  POSTS: 'Đang quét bài viết trên hồ sơ',
  COLLECTING: 'Đang lưu ảnh, video và bình luận',
  COMPLETE: 'Đã lưu đầy đủ phần xác minh được',
  PARTIAL: 'Đã lưu một phần',
  FAILED: 'Lượt quét gián đoạn',
  STALLED: 'Lượt quét hết thời gian chờ',
};

export interface SourceProfileScanState {
  status: keyof typeof statusLabel;
  active: boolean;
  createdAt: string;
  snapshot: ProfileDetailsSnapshot | null;
  artwork: { avatar?: string; cover?: string };
  issues: string[];
  stats: {
    posts: number; comments: number; commentsComplete: number; commentsPending: number;
    images: number; videos: number; mediaPending: number; mediaMissing: number; captionsMissing: number;
  };
}

export function SourceProfileScan({ scan, code }: { scan: SourceProfileScanState; code: string }) {
  const { active, status, stats, artwork, snapshot } = scan;
  const commentsMissing = stats.posts - stats.commentsComplete - stats.commentsPending;
  const issues = [
    ...scan.issues,
    ...(stats.mediaMissing ? [`${stats.mediaMissing} bài còn thiếu ảnh hoặc video.`] : []),
    ...(stats.captionsMissing ? [`${stats.captionsMissing} bài có nội dung bị cắt.`] : []),
    ...(commentsMissing ? [`${commentsMissing} bài còn thiếu hoặc chưa xác minh đủ bình luận và phản hồi.`] : []),
  ];
  return <section className="card workflow-stack" aria-labelledby="source-scan-status">
    <div className="workflow-toolbar">
      <h2 id="source-scan-status">Bản quét hồ sơ {code}</h2>
      <Badge s={active ? 'STARTED' : status === 'COMPLETE' ? 'OK' : 'NEEDS_OPERATOR'} text={statusLabel[status]} />
    </div>
    <p className="muted" role="status">
      {fmtTime(scan.createdAt)} · {stats.posts} bài đã lưu · {stats.comments} bình luận và phản hồi đã lưu
      {(stats.images > 0 || stats.videos > 0) && ` · ${stats.images} ảnh · ${stats.videos} video trong bài`}
      {stats.commentsPending > 0 && ` · ${stats.commentsPending} bài đang chờ quét bình luận`}
      {stats.mediaPending > 0 && ` · ${stats.mediaPending} bài đang chờ lưu ảnh/video`}
    </p>
    {issues.length > 0 && <ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    {snapshot && <>
      <div className={styles.profilePhotos}>
        {artwork.avatar && <a href={`/bff/assets/${artwork.avatar}/content`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/bff/assets/${artwork.avatar}/content`} alt="Ảnh đại diện đã lưu" />
        </a>}
        {artwork.cover && <a href={`/bff/assets/${artwork.cover}/content`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/bff/assets/${artwork.cover}/content`} alt="Ảnh bìa đã lưu" />
        </a>}
      </div>
      <ProfileDetailsView snapshot={snapshot} />
    </>}
  </section>;
}
