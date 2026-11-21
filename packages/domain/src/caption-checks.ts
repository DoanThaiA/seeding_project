/**
 * Deterministic caption checks (spec §8). These are signals, not proof: anything that fails
 * goes to NEEDS_REVIEW; nothing here can make a caption READY on its own beyond these rules.
 */

export interface CheckResult {
  kind: string;
  passed: boolean;
  details?: Record<string, unknown>;
}

const NEGATIONS_VI = ['không', 'chưa', 'chẳng', 'chả', 'đừng', 'chớ', 'không được', 'cấm', 'miễn'];
const NEGATIONS_EN = ['not', 'no', 'never', "n't", 'without'];

function norm(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** Numbers, percentages, money, dates and times as they appear in text, normalised. */
export function extractNumericTokens(text: string): string[] {
  const out = new Set<string>();
  const re = /\d+(?:[.,:/-]\d+)*\s*%?/g;
  for (const m of norm(text).matchAll(re)) {
    out.add(m[0].replace(/\s+/g, ''));
  }
  return [...out];
}

function canon(numTok: string): string {
  // "1.000.000" vs "1,000,000" vs "1000000" all compare equal; dates keep separators.
  if (/^\d{1,3}([.,]\d{3})+%?$/.test(numTok)) return numTok.replace(/[.,]/g, '');
  return numTok;
}

export function checkFactsPreserved(source: string, caption: string, facts: string[] = []): CheckResult {
  const capNums = new Set(extractNumericTokens(caption).map(canon));
  const missingNumbers = extractNumericTokens(source)
    .map(canon)
    .filter((n) => !capNums.has(n));
  const capN = norm(caption);
  const missingFacts = facts.filter((f) => {
    const nums = extractNumericTokens(f).map(canon);
    if (nums.length) return nums.some((n) => !capNums.has(n));
    return !capN.includes(norm(f).trim());
  });
  return {
    kind: 'facts_preserved',
    passed: missingNumbers.length === 0 && missingFacts.length === 0,
    details: { missingNumbers, missingFacts },
  };
}

function countNegations(text: string): number {
  const t = ` ${norm(text).replace(/[^\p{L}\p{N}'\s]/gu, ' ')} `;
  let n = 0;
  for (const w of [...NEGATIONS_VI, ...NEGATIONS_EN]) {
    const re = new RegExp(`(?<=\\s)${w.replace(/'/g, "'")}(?=\\s)`, 'gu');
    n += (t.match(re) ?? []).length;
  }
  return n;
}

export function checkNegationKept(source: string, caption: string): CheckResult {
  const s = countNegations(source);
  const c = countNegations(caption);
  return { kind: 'negation_kept', passed: s === 0 || c > 0, details: { source: s, caption: c } };
}

export function checkLength(caption: string, max = 5000): CheckResult {
  const len = caption.trim().length;
  return { kind: 'length', passed: len > 0 && len <= max, details: { length: len, max } };
}

export function runCaptionChecks(input: { source: string; caption: string; facts?: string[]; maxLength?: number }): CheckResult[] {
  return [
    checkLength(input.caption, input.maxLength),
    checkFactsPreserved(input.source, input.caption, input.facts),
    checkNegationKept(input.source, input.caption),
  ];
}
