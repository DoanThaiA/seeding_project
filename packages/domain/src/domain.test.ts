import { describe, expect, it } from 'vitest';
import { POST_COMMIT_ACTIVE, PRE_COMMIT, PUBLICATION_STATUSES, SUCCESS, canTransition, TRANSITION_TABLES } from '@seedingsys/contracts';
import { checkFactsPreserved, checkNegationKept, extractNumericTokens, runCaptionChecks } from './caption-checks';
import { captionFingerprint, hashObject } from './hash';
import { isPastLaunchWindow, topOfHour, vnDay } from './time';

describe('publication state machine', () => {
  it('never allows a retry path from a post-commit state back to a pre-commit state', () => {
    for (const from of POST_COMMIT_ACTIVE) for (const to of PRE_COMMIT) expect(canTransition('publication', from, to), `${from}→${to}`).toBe(false);
    for (const to of PRE_COMMIT) expect(canTransition('publication', 'UNKNOWN', to)).toBe(false);
    for (const to of PRE_COMMIT) expect(canTransition('publication', 'RECONCILING', to)).toBe(false);
  });
  it('UNKNOWN can only become success through verification or an operator', () => {
    expect(canTransition('publication', 'UNKNOWN', 'PUBLISHED_VERIFIED')).toBe(false);
    expect(canTransition('publication', 'RECONCILING', 'PUBLISHED_VERIFIED')).toBe(true);
    expect(SUCCESS).not.toContain('UNKNOWN');
  });
  it('success states are terminal', () => {
    for (const s of SUCCESS) expect(TRANSITION_TABLES.publication[s]).toEqual([]);
  });
  it('covers every status', () => {
    expect(Object.keys(TRANSITION_TABLES.publication).sort()).toEqual([...PUBLICATION_STATUSES].sort());
  });
});

describe('caption checks', () => {
  it('extracts numbers, percentages and dates', () => {
    expect(extractNumericTokens('Giảm 30% đến 25/11, giá 1.200.000đ')).toEqual(['30%', '25/11', '1.200.000']);
  });
  it('flags a missing number', () => {
    expect(checkFactsPreserved('Giảm 30% đến 25/11', 'Giảm 30% cuối tháng').passed).toBe(false);
    expect(checkFactsPreserved('Giảm 30% đến 25/11', 'Ưu đãi 30% tới ngày 25/11').passed).toBe(true);
  });
  it('treats 1.000.000 and 1,000,000 as the same number', () => {
    expect(checkFactsPreserved('Giá 1.000.000 đồng', 'Chỉ 1,000,000 đồng').passed).toBe(true);
  });
  it('flags a lost negation', () => {
    expect(checkNegationKept('Không áp dụng cho đơn online', 'Áp dụng cho đơn online').passed).toBe(false);
    expect(checkNegationKept('Không áp dụng cho đơn online', 'Ưu đãi không áp dụng online').passed).toBe(true);
  });
  it('accepts a long caption preserved exactly from the original', () => {
    const long = Array.from({ length: 60 }, (_, i) => `từ${i}`).join(' ');
    expect(runCaptionChecks({ source: long, caption: long }).every(check => check.passed)).toBe(true);
  });
});

describe('time & hashing', () => {
  it('top of hour and VN day', () => {
    expect(topOfHour(new Date('2026-11-20T03:47:12.345Z')).toISOString()).toBe('2026-11-20T03:00:00.000Z');
    expect(vnDay(new Date('2026-11-20T17:30:00Z'))).toBe('2026-11-21');
  });
  it('launch window', () => {
    const slot = new Date('2026-11-20T03:00:00Z');
    expect(isPastLaunchWindow(slot, 15, new Date('2026-11-20T03:15:00Z'))).toBe(false);
    expect(isPastLaunchWindow(slot, 15, new Date('2026-11-20T03:15:01Z'))).toBe(true);
  });
  it('stable hashes', () => {
    expect(hashObject({ a: 1, b: [1, 2] })).toBe(hashObject({ b: [1, 2], a: 1 }));
    expect(captionFingerprint(' Xin  chào\n')).toBe(captionFingerprint('xin chào'));
  });
});
