import { createHash } from 'node:crypto';

/** JSON stringify with sorted keys so equal objects always hash equally. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashObject(v: unknown): string {
  return sha256(stableStringify(v));
}

/** Whitespace/case-insensitive caption fingerprint used to find our post on a timeline. */
export function captionFingerprint(caption: string): string {
  return sha256(caption.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase());
}

/** Content hash of a source revision: text + ordered media identities + album title. */
export function revisionContentHash(input: { text: string; albumTitle?: string | null; media: Array<{ ref: string }> }): string {
  return hashObject({ t: input.text.normalize('NFC').trim(), a: input.albumTitle ?? null, m: input.media.map((m) => m.ref) });
}
