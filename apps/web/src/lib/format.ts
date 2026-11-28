const TZ = 'Asia/Ho_Chi_Minh';

export function fmtTime(v: string | Date | null | undefined, withDate = true): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(v));
}

export function ago(v: string | Date | null | undefined, now = Date.now()): string {
  if (!v) return '—';
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

export const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

const TONES: Record<string, [Tone, string]> = {
  // publication
  QUEUED: ['info', 'Chờ chạy'],
  PREPARING: ['info', 'Đang soạn'],
  UPLOADING_DRAFT: ['info', 'Đang tải nháp'],
  READY_TO_SUBMIT: ['info', 'Sẵn sàng đăng'],
  COMMITTING: ['warn', 'Đang bấm đăng'],
  PLATFORM_PROCESSING: ['info', 'Nền tảng xử lý'],
  VERIFYING: ['info', 'Đang xác minh'],
  PUBLISHED_VERIFIED: ['ok', 'Đã đăng (xác minh)'],
  OPERATOR_CONFIRMED: ['ok', 'Người xác nhận'],
  FAILED_CONFIRMED: ['bad', 'Thất bại (chắc chắn)'],
  UNKNOWN: ['warn', 'Chưa rõ kết quả'],
  RECONCILING: ['warn', 'Đang đối soát'],
  NEEDS_OPERATOR: ['bad', 'Cần người xử lý'],
  CANCELLED: ['muted', 'Đã hủy'],
  // slot
  PLANNED: ['muted', 'Đã lên lịch'],
  RESERVED: ['info', 'Đã giữ chỗ'],
  DISPATCHED: ['info', 'Đã giao việc'],
  STARTED: ['info', 'Đang chạy'],
  DONE: ['ok', 'Xong'],
  STOPPED: ['muted', 'Đã dừng'],
  SKIPPED_NO_CONTENT: ['muted', 'Không có bài'],
  DEFERRED: ['warn', 'Hoãn'],
  MISSED: ['bad', 'Lỡ lượt'],
  // variant
  COLLECTED: ['info', 'Đã thu thập'],
  FETCHING_MEDIA: ['info', 'Đang tải media'],
  REWRITING: ['info', 'Đang chuẩn bị caption'],
  VALIDATING: ['info', 'Đang kiểm tra'],
  READY: ['ok', 'Sẵn sàng'],
  NEEDS_REVIEW: ['warn', 'Cần duyệt'],
  REJECTED: ['muted', 'Đã loại'],
  EXPIRED: ['muted', 'Hết hiệu lực'],
  DUPLICATE: ['muted', 'Trùng bài'],
  // comment replay
  DRAFT: ['muted', 'Bản nháp'],
  APPROVED: ['info', 'Đã duyệt'],
  POSTED: ['ok', 'Đã ghi nhận đăng'],
  OMITTED: ['muted', 'Đã bỏ qua'],
  // tasks
  OPEN: ['warn', 'Mở'],
  CLAIMED: ['info', 'Đã nhận'],
  // formats
  TEXT: ['muted', 'Chữ'],
  QUOTE_IMAGE: ['muted', 'Quote ảnh'],
  SINGLE_PHOTO: ['muted', '1 ảnh'],
  MULTI_PHOTO: ['muted', 'Nhiều ảnh'],
  NAMED_ALBUM: ['muted', 'Album có tên'],
  VIDEO: ['muted', 'Video'],
  REEL: ['muted', 'Reel'],
  UNSUPPORTED: ['bad', 'Chưa hỗ trợ'],
};

export const tone = (s: string): Tone => TONES[s]?.[0] ?? 'muted';
export const label = (s: string): string => TONES[s]?.[1] ?? s;

const REASONS: Record<string, string> = {
  MANUAL_REVIEW_MODE: 'Tài khoản đang ở chế độ duyệt tay',
  PROFILE_SYNC_REVIEW: 'Bản sao từ lượt đồng bộ profile',
  SOURCE_REVISION_RESTORED: 'Bài nguồn đã quay lại phiên bản cũ, cần duyệt lại',
  SOURCE_REVISION_CHANGED: 'Bài nguồn đã có bản mới, cần chuẩn bị lại bản đăng',
  PAGINATION_INCOMPLETE: 'Nguồn còn trang chưa đọc',
  SOURCE_INCOMPLETE: 'Nguồn đọc chưa đầy đủ (caption bị cắt / thiếu media)',
  MEDIA_FETCH_FAILED: 'Không tải được toàn bộ media',
  UNSUPPORTED_FORMAT: 'Cần chọn nội dung bản đăng',
  NAMED_ALBUM_NOT_CERTIFIED: 'Cần chọn nội dung bản đăng',
  FACT_MISSING: 'Caption thiếu số liệu/dữ kiện của bài gốc',
  NEGATION_LOST: 'Caption làm mất ý phủ định',
  NEAR_VERBATIM_COPY: 'Kiểm tra caption cũ',
  MEDIA_UNAVAILABLE: 'Thiếu tệp ảnh hoặc video gốc',
  MEDIA_COUNT_UNKNOWN: 'Chưa đủ ảnh của bộ ảnh gốc',
  CAPTION_TRUNCATED: 'Caption còn phần chưa đọc được',
  EMPTY_CAPTION: 'Caption rỗng',
  CAPTION_TOO_LONG: 'Caption quá dài',
  LLM_FLAGGED: 'Mô hình đề nghị người kiểm tra',
  LLM_FAILED: 'Biên tập tự động thất bại',
  LLM_BUDGET_EXHAUSTED: 'Hết ngân sách LLM trong ngày',
  DUPLICATE_CONTENT: 'Trùng nội dung với bài khác đã đăng hoặc đang chờ đăng trên tài khoản này',
  SHARED_POST_RIGHTS_CHECK: 'Bài chia sẻ — kiểm tra quyền sử dụng',
  LOW_IDENTITY_CONFIDENCE: 'Định danh bài nguồn kém tin cậy',
  SESSION_LOGGED_OUT: 'Profile bị đăng xuất',
  SESSION_CHECKPOINT: 'Facebook yêu cầu xác minh (checkpoint)',
  AUDIENCE_MISMATCH: 'Đối tượng xem trên preview không khớp',
  LAUNCH_WINDOW_EXPIRED: 'Quá cửa sổ khởi chạy',
  OUTSIDE_SOURCE_WINDOW: 'Ngoài khung giờ nguồn',
  ACCOUNT_BUSY: 'Tài khoản đang xử lý lượt trước',
  UNRESOLVED_PUBLICATION: 'Tài khoản còn bài cần đối chiếu',
  NO_WORKER: 'Đang chờ worker của tài khoản',
  NO_CONNECTOR_RELEASE: 'Chưa có kết nối đăng đang hoạt động',
  TARGET_DISABLED: 'Tài khoản đích đang tắt',
  MAPPING_DISABLED: 'Luồng nguồn → đích đang tắt',
  PUBLISH_INTERVAL_NOT_ELAPSED: 'Đang chờ đủ khoảng cách giữa hai bài',
  STRICT_ORDER_WAIT: 'Đang đợi bài cũ hơn được xử lý',
  PUBLICATION_SCHEDULE: 'Được giao từ lịch đã tạo',
  SCHEDULE_STOPPED: 'Lịch đã dừng',
  SCHEDULE_RESERVED: 'Bài đã được đặt lịch',
  PROFILE_SYNC_RESERVED: 'Bài thuộc lượt đồng bộ hồ sơ',
  NO_ELIGIBLE_CONTENT: 'Chưa có bài đủ điều kiện cho lượt này',
  MANUAL_PUBLISH: 'Được giao đăng ngay',
  PROFILE_SYNC: 'Được giao từ lượt đồng bộ hồ sơ',
};

export function reasonText(r: string): string {
  if (REASONS[r]) return REASONS[r];
  if (r.startsWith('WRONG_IDENTITY')) return 'Profile đang đăng nhập sai tài khoản';
  if (r.startsWith('KILL_SWITCH')) return 'Đang bị tạm dừng bằng công tắc dừng';
  if (r.startsWith('AMBIGUOUS_')) return 'Tìm thấy nhiều hơn 1 bài khớp trên trang';
  if (r === 'RECONCILE_EXHAUSTED') return 'Đối soát nhiều lần vẫn chưa rõ';
  return r;
}
