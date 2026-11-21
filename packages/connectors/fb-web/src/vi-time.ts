/**
 * Facebook shows post times as relative text in the viewer's locale ("Vừa xong", "5 phút",
 * "Hôm qua lúc 21:04", "20 tháng 11 lúc 09:15"). We parse the common vi-VN forms into an
 * approximate instant plus a tolerance (how coarse the text is). Anything unrecognised → null,
 * and callers must then treat the post as "cannot be dated" — never as a match.
 */
export interface ApproxTime {
  at: Date;
  tolMs: number;
}

const VN_OFFSET_MS = 7 * 3600_000;
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Build an instant from a wall-clock time in Vietnam (UTC+7, no DST). */
function vnWallClock(y: number, month: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, month - 1, d, hh, mm) - VN_OFFSET_MS);
}

export function parseViTime(text: string, now: Date): ApproxTime | null {
  const t = text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/^(?:chủ nhật|thứ [\p{L}\d]+),\s*/u, '');
  if (!t) return null;
  if (t === 'vừa xong' || t === 'bây giờ') return { at: now, tolMs: MIN };

  // `\b` is ASCII-only in JS and misses the boundary after "giờ": use a Unicode-aware lookahead.
  const unit = (u: string) => new RegExp(`^(\\d+)\\s*(?:${u})(?![\\p{L}\\p{N}])`, 'u');
  let m = t.match(unit('giây|s'));
  if (m) return { at: new Date(now.getTime() - Number(m[1]) * 1000), tolMs: MIN };
  m = t.match(unit('phút|p'));
  if (m) return { at: new Date(now.getTime() - Number(m[1]) * MIN), tolMs: MIN };
  m = t.match(unit('giờ|h'));
  if (m) return { at: new Date(now.getTime() - Number(m[1]) * HOUR), tolMs: HOUR };
  m = t.match(unit('ngày|d'));
  if (m) return { at: new Date(now.getTime() - Number(m[1]) * DAY), tolMs: DAY };

  const vnNow = new Date(now.getTime() + VN_OFFSET_MS);
  const y = vnNow.getUTCFullYear();
  m = t.match(/^hôm qua lúc (\d{1,2}):(\d{2})/);
  if (m) {
    const yesterday = new Date(vnNow.getTime() - DAY);
    return { at: vnWallClock(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate(), Number(m[1]), Number(m[2])), tolMs: 2 * MIN };
  }
  m = t.match(/^hôm nay lúc (\d{1,2}):(\d{2})/);
  if (m) return { at: vnWallClock(y, vnNow.getUTCMonth() + 1, vnNow.getUTCDate(), Number(m[1]), Number(m[2])), tolMs: 2 * MIN };
  m = t.match(/^(\d{1,2}) tháng (\d{1,2})(?:,? (\d{4}))? lúc (\d{1,2}):(\d{2})/);
  if (m) {
    let at = vnWallClock(m[3] ? Number(m[3]) : y, Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
    if (!m[3] && at.getTime() > now.getTime() + DAY) at = vnWallClock(y - 1, Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
    return { at, tolMs: 2 * MIN };
  }
  m = t.match(/^(\d{1,2}) tháng (\d{1,2})(?:,? (\d{4}))?$/);
  if (m) {
    let at = vnWallClock(m[3] ? Number(m[3]) : y, Number(m[2]), Number(m[1]), 12, 0);
    if (!m[3] && at.getTime() > now.getTime() + DAY) at = vnWallClock(y - 1, Number(m[2]), Number(m[1]), 12, 0);
    return { at, tolMs: DAY / 2 + MIN };
  }
  return null;
}
