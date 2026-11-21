import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ConnectorError, type MediaFile, type PublishConnector, type TargetRef } from '@seedingsys/connectors-core';
import type { ContentType, PublishSnapshot } from '@seedingsys/contracts';
import { captionFingerprint } from '@seedingsys/domain';

/** Pass thresholds from the pilot acceptance criteria (spec §18). */
export const THRESHOLDS: Partial<Record<ContentType, number>> = {
  TEXT: 0.95,
  QUOTE_IMAGE: 0.95,
  SINGLE_PHOTO: 0.95,
  MULTI_PHOTO: 0.9,
  VIDEO: 0.9,
  REEL: 0.9,
};
export const MIN_CASES = 20;

export interface CaseResult {
  n: number;
  ok: boolean;
  stage: string;
  detail?: string;
}
export interface FormatResult {
  format: ContentType;
  cases: number;
  failures: number;
  passRate: number;
  threshold: number;
  passed: boolean;
  /** Set when the run stopped early because continuing would be unsafe. */
  aborted?: string;
  results: CaseResult[];
}

// ───────────── tiny valid PNG generator (distinct bytes per image) ─────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A solid-colour w×h PNG; every (seed) gives different bytes → different checksum. */
export function makePng(seed: number, w = 160, h = 120): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const r = (seed * 53) % 256, g = (seed * 97 + 40) % 256, b = (seed * 29 + 120) % 256;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ABORT_KINDS = new Set(['CHECKPOINT', 'SESSION_LOGGED_OUT', 'WRONG_IDENTITY', 'AUDIENCE_MISMATCH']);

export interface RunOptions {
  connector: PublishConnector;
  target: TargetRef;
  formats: ContentType[];
  casesPerFormat: number;
  /** Minimum cases for a format to be certifiable (defaults to the spec's 20). */
  minCases?: number;
  /** Pause between posts. Posting dozens of test posts back-to-back is itself risky for the account. */
  pauseMs: number;
  workDir: string;
  /** A real video file is needed to test VIDEO (we cannot synthesise one without FFmpeg). */
  videoPath?: string;
  /** How long to keep looking for a just-posted test post on the timeline. */
  verifyTimeoutMs?: number;
  verifyEveryMs?: number;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Run real posts against the target in "Chỉ mình tôi" mode and report per-format pass rates.
 * It REFUSES to run unless the target's audience is ONLY_ME, and stops the whole run at the first
 * sign that continuing is unsafe (checkpoint, logged out, wrong identity, wrong audience, or a
 * post whose outcome is unclear). Test posts are not deleted automatically.
 */
export async function runCapability(o: RunOptions): Promise<FormatResult[]> {
  if (o.target.audience !== 'ONLY_ME') throw new Error(`Capability tests only run on targets whose audience is ONLY_ME (${o.target.code} is ${o.target.audience})`);
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => new Date());
  const minCases = o.minCases ?? MIN_CASES;
  const runId = now().toISOString().replace(/\D/g, '').slice(0, 14);
  mkdirSync(o.workDir, { recursive: true });
  const out: FormatResult[] = [];
  let aborted: string | undefined;

  for (const format of o.formats) {
    const res: FormatResult = { format, cases: 0, failures: 0, passRate: 0, threshold: THRESHOLDS[format] ?? 1, passed: false, results: [] };
    out.push(res);
    if (aborted) {
      res.aborted = aborted;
      continue;
    }
    const video = format === 'VIDEO' || format === 'REEL';
    if (video && !o.videoPath) {
      res.aborted = 'Cần --video <tệp> để thử ' + format;
      continue;
    }
    let consecutiveFail = 0;
    for (let n = 1; n <= o.casesPerFormat; n++) {
      if (n > 1 || out.length > 1) await sleep(o.pauseMs);
      const caption = `[SeedingSys capability test ${runId}] ${format} #${n}/${o.casesPerFormat} — bài thử, chỉ mình tôi xem được, có thể xóa.`;
      const files: MediaFile[] = [];
      const count = format === 'MULTI_PHOTO' ? 3 : format === 'SINGLE_PHOTO' || format === 'QUOTE_IMAGE' ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const p = join(o.workDir, `${runId}-${format}-${n}-${i}.png`);
        writeFileSync(p, makePng(n * 10 + i));
        files.push({ position: i, checksum: `c${n}-${i}`, mime: 'image/png', kind: 'image', location: p });
      }
      if (video) files.push({ position: 0, checksum: 'video', mime: 'video/mp4', kind: 'video', location: o.videoPath! });
      const snapshot: PublishSnapshot = {
        variantId: `cap-${runId}-${format}-${n}`,
        targetId: o.target.id,
        contentType: format,
        caption,
        audience: 'ONLY_ME',
        media: files.map((f) => ({ position: f.position, assetId: `a${f.position}`, checksum: f.checksum, objectKey: 'cap', mime: f.mime, kind: f.kind })),
      };

      const c = await runOne(o, snapshot, files, caption, now, sleep);
      res.cases++;
      res.results.push({ n, ok: c.ok, stage: c.stage, detail: c.detail });
      log(`${format} #${n}: ${c.ok ? 'ĐẠT' : `KHÔNG ĐẠT (${c.stage}: ${c.detail})`}`);
      if (c.ok) consecutiveFail = 0;
      else {
        res.failures++;
        consecutiveFail++;
      }
      if (c.abort) {
        aborted = res.aborted = `${c.stage}: ${c.detail}`;
        break;
      }
      if (consecutiveFail >= 3) {
        res.aborted = `3 lần liên tiếp không đạt — dừng thử ${format}`;
        break;
      }
    }
    res.passRate = res.cases ? (res.cases - res.failures) / res.cases : 0;
    res.passed = !res.aborted && res.cases >= minCases && res.passRate >= res.threshold;
  }
  return out;
}

async function runOne(
  o: RunOptions,
  snapshot: PublishSnapshot,
  files: MediaFile[],
  caption: string,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; stage: string; detail?: string; abort?: boolean }> {
  let stage = 'open';
  let committed = false;
  const s = await o.connector.openSession(o.target).catch((e) => {
    throw e;
  });
  try {
    stage = 'session';
    const st = await s.sessionState();
    if (st !== 'OK') return { ok: false, stage, detail: st, abort: true };
    stage = 'identity';
    const id = await s.checkIdentity(o.target.externalId);
    if (!id.ok) return { ok: false, stage, detail: `đang đăng nhập ${id.observed ?? '?'}`, abort: true };
    stage = 'prepare';
    const draft = await s.prepare(snapshot, files);
    stage = 'preview';
    const pv = await s.previewCheck(draft, { caption, mediaCount: files.length, mediaChecksums: files.map((f) => f.checksum), audience: 'ONLY_ME' });
    if (!pv.audienceOk) {
      await s.discardDraft(draft);
      return { ok: false, stage, detail: `đối tượng xem không phải "Chỉ mình tôi" — ${pv.problems.join('; ')}`, abort: true };
    }
    if (!pv.ok) {
      await s.discardDraft(draft);
      return { ok: false, stage, detail: pv.problems.join('; ') };
    }
    stage = 'commit';
    committed = true;
    const committedAt = now();
    const signal = await s.commit(draft);
    if ((snapshot.contentType === 'VIDEO' || snapshot.contentType === 'REEL') && s.waitProcessing) await s.waitProcessing(signal, async () => undefined);
    stage = 'verify';
    const deadline = Date.now() + (o.verifyTimeoutMs ?? 60_000);
    for (;;) {
      const v = await s.verify({ captionFingerprint: captionFingerprint(caption), contentType: snapshot.contentType, caption, mediaCount: files.length, committedAt, windowMs: 30 * 60_000, commitSignal: signal });
      if (v.kind === 'VERIFIED') return { ok: true, stage };
      if (v.kind === 'AMBIGUOUS') return { ok: false, stage, detail: 'nhiều bài khớp', abort: true };
      // Posts are visible but none has a readable time: reloading will not help — stop and report.
      const ev = (v.kind === 'NOT_FOUND' ? v.evidence : undefined) as { scanned?: number; unreadable?: number } | undefined;
      if (ev && (ev.scanned ?? 0) > 0 && ev.unreadable === ev.scanned) {
        return { ok: false, stage, detail: `đã đăng nhưng không đọc được thời gian của ${ev.scanned} bài trên trang (cần chỉnh selector xác minh; xem *.timeline.json trong thư mục ảnh chụp) — bài thử có thể đã lên, hãy kiểm tra và xóa`, abort: true };
      }
      if (ev && (ev.scanned ?? 0) === 0 && Date.now() > deadline - (o.verifyTimeoutMs ?? 60_000) / 2) {
        return { ok: false, stage, detail: 'đã đăng nhưng không thấy bài viết nào trên trang cá nhân (selector bài viết chưa khớp; xem *.timeline.json) — hãy kiểm tra và xóa bài thử', abort: true };
      }
      if (Date.now() > deadline) return { ok: false, stage, detail: 'đã đăng nhưng không thấy bài trên trang — kết quả chưa rõ, dừng để người kiểm tra', abort: true };
      await sleep(o.verifyEveryMs ?? 15_000);
    }
  } catch (e) {
    const kind = e instanceof ConnectorError ? e.kind : 'ERROR';
    const detail = `${kind}: ${(e as Error).message}`.slice(0, 300);
    // Anything that went wrong after pressing Post leaves an unknown outcome: stop the run.
    return { ok: false, stage, detail, abort: committed || ABORT_KINDS.has(kind) };
  } finally {
    await s.close().catch(() => undefined);
  }
}
