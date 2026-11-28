import { z } from 'zod';

/** TargetBrowserRun chỉ để kiểm tra tài khoản B còn dùng được không (không đăng gì). */
export const TARGET_HEALTH_KIND = 'health';
/** Quá thời gian này mà chưa xong thì coi như lượt kiểm tra bị treo. */
export const TARGET_HEALTH_MS = 10 * 60_000;

export const TargetHealthState = z.enum(['OK', 'LOGGED_OUT', 'CHECKPOINT', 'WRONG_ACCOUNT']);
export type TargetHealthState = z.infer<typeof TargetHealthState>;

export const TargetHealthResult = z.object({
  ok: z.boolean(),
  state: TargetHealthState,
  observed: z.string().max(200).nullable(),
  /** True khi lượt kiểm tra này đã tự tắt nguồn B. */
  disabled: z.boolean(),
  checkedAt: z.string().datetime(),
});
export type TargetHealthResult = z.infer<typeof TargetHealthResult>;

/** Nhãn tiếng Việt dùng chung cho API và web. */
export const TARGET_HEALTH_TEXT: Record<TargetHealthState, string> = {
  OK: 'Còn hoạt động',
  LOGGED_OUT: 'Phiên đã đăng xuất',
  CHECKPOINT: 'Facebook yêu cầu xác minh',
  WRONG_ACCOUNT: 'Đang đăng nhập tài khoản khác',
};
