import { hashObject } from './hash';

/**
 * Duplicate detection for collected posts.
 *
 * Two different questions, two different tools:
 *  - "Is this read the SAME post we already stored?" — `isSamePost`. Facebook can hand out a
 *    different pfbid for one post between sessions, so a new id alone does not mean a new post.
 *  - "Does a target already have THIS CONTENT?" — `contentKey`. Same caption + same media bytes,
 *    whatever source post it came from, must reach one target account only once.
 */

const URLS = /https?:\/\/[^\s<>"']+/gi;
const INVISIBLE = /[­​-‏⁠﻿]/g;
const SEE_MORE = /(?:…|\.{3})?\s*(?:xem thêm|see more)\s*$/i;
const ELLIPSIS = /\s*(?:…|\.{3})$/;

/** Caption reduced to what identifies the content: no links, invisible characters, case or spacing differences. */
export function contentText(text: string): string {
  return text.normalize('NFC').replace(URLS, ' ').replace(INVISIBLE, '').replace(SEE_MORE, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Fingerprint of a source revision whose media is settled: caption + media bytes (order-free).
 * Returns '' when there is nothing to compare (no caption, no media) — such posts are never duplicates.
 */
export function contentKey(input: { text: string; albumTitle?: string | null; checksums: string[] }): string {
  const text = contentText(input.text);
  const media = [...input.checksums].sort();
  if (!text && !media.length) return '';
  return hashObject({ t: text, a: input.albumTitle ? contentText(input.albumTitle) : null, m: media });
}

/** Platform media id inside a guest/session reader ref ("fb-public:<post>:image:<photo id>" → "image:<photo id>"). */
export function stableMediaKey(ref: string): string | null {
  const m = /^fb-public:[^:]+:(image|video):(.+)$/.exec(ref);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Move a media ref read under an alias post id onto the stored post id, so an unchanged post hashes the same. */
export function rebaseMediaRef(ref: string, fromId: string, toId: string): string {
  const parts = ref.split(':');
  return parts.length > 2 && parts[1] === fromId ? [parts[0], toId, ...parts.slice(2)].join(':') : ref;
}

export interface PostFacts {
  text: string;
  /** The caption was cut ("Xem thêm" could not be expanded). */
  truncated: boolean;
  /** Any completeness flag: format and media count may be wrong. */
  incomplete: boolean;
  contentType: string;
  mediaRefs: string[];
  postedAt?: Date | null;
  postedAtExact?: boolean;
}

/** Facebook shows minute precision; a read across a minute boundary can differ by one. */
const EXACT_TOLERANCE_MS = 3 * 60_000;
/** Relative stamps ("2 giờ", "Hôm qua") and day-only dates. */
const LOOSE_TOLERANCE_MS = 36 * 3_600_000;
/** A cut caption must still be long enough to identify the post. */
const MIN_PREFIX = 24;

/**
 * Whether two reads from ONE source are the same post although the platform gave them different ids.
 * Shared photo/video ids decide on their own. Otherwise the caption must match (a cut caption may be a
 * prefix) and neither the time nor the format may contradict it.
 */
export function isSamePost(a: PostFacts, b: PostFacts): boolean {
  const keysA = new Set(a.mediaRefs.map(stableMediaKey).filter((k): k is string => !!k));
  const keysB = new Set(b.mediaRefs.map(stableMediaKey).filter((k): k is string => !!k));
  if (keysA.size && keysB.size) return [...keysA].some(k => keysB.has(k));

  const textA = contentText(a.text);
  const textB = contentText(b.text);
  if (!textA || !textB) return false;
  const prefix = (cut: string, full: string) => {
    const head = cut.replace(ELLIPSIS, '');
    return head.length >= MIN_PREFIX && full.startsWith(head);
  };
  if (textA !== textB && !(a.truncated && prefix(textA, textB)) && !(b.truncated && prefix(textB, textA))) return false;

  if (a.postedAt && b.postedAt) {
    const tolerance = a.postedAtExact && b.postedAtExact ? EXACT_TOLERANCE_MS : LOOSE_TOLERANCE_MS;
    if (Math.abs(a.postedAt.getTime() - b.postedAt.getTime()) > tolerance) return false;
  }
  if (!a.incomplete && !b.incomplete && (a.contentType !== b.contentType || a.mediaRefs.length !== b.mediaRefs.length)) return false;
  return true;
}
