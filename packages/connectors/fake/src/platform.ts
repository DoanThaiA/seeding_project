import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentType } from '@seedingsys/contracts';

/**
 * An in-memory stand-in for the social platform, used for local dev, CI e2e and fault injection.
 * With `file` set, state is persisted to JSON so several local processes share one "platform".
 */

export interface FakeSourcePost {
  id: string;
  seq: number; // monotonically increasing per source; edits bump `editSeq`
  editSeq: number;
  text: string;
  albumTitle?: string;
  contentType: ContentType;
  media: Array<{ kind: 'image' | 'video'; ref: string }>;
  isPinned?: boolean;
  isShared?: boolean;
  postedAt: string;
  /** Simulate an incomplete read (truncated caption, unknown media count...). */
  incomplete?: string[];
}

export interface FakeTimelinePost {
  id: string;
  caption: string;
  mediaChecksums: string[];
  audience: string;
  albumTitle?: string | null;
  at: string;
  /** Set when a video is still processing on the platform. */
  processingUntil?: string;
}

export interface FakeAccount {
  externalId: string;
  session: 'OK' | 'LOGGED_OUT' | 'CHECKPOINT';
  /** Identity the browser profile is actually logged in as (to simulate a wrong profile). */
  loggedInAs?: string;
  timeline: FakeTimelinePost[];
}

export interface FakeState {
  nextSeq: number;
  sources: Record<string, { readable: boolean; posts: FakeSourcePost[] }>;
  accounts: Record<string, FakeAccount>;
}

export type FaultStage =
  | 'read'
  | 'fetchMedia'
  | 'prepare'
  | 'preview'
  | 'commit.before' // fails before the post exists → safe
  | 'commit.after' // post exists, then the call fails → side effect happened
  | 'verify'
  | 'processing';

export type FaultAction =
  | { kind: 'throw'; errorKind: string; sideEffectPossible?: boolean }
  | { kind: 'hang'; onEnter?: () => void } // never resolves: simulates a dead worker / frozen browser
  | { kind: 'gate'; wait: Promise<void>; onEnter?: () => void } // blocks until the test opens the gate (worker alive but stalled)
  | { kind: 'previewMismatch' }
  | { kind: 'audienceMismatch' }
  | { kind: 'verifyNotFound' }
  | { kind: 'verifyAmbiguous' }
  | { kind: 'dropPost' }; // commit "succeeds" in UI but nothing is posted

export interface FaultRule {
  stage: FaultStage;
  action: FaultAction;
  /** Only for this account / source (externalId or source externalRef). */
  match?: string;
  times?: number; // default 1
}

export class FakePlatform {
  private state: FakeState = { nextSeq: 1, sources: {}, accounts: {} };
  private faults: FaultRule[] = [];

  constructor(
    private readonly opts: { file?: string; now?: () => Date } = {},
  ) {
    this.load();
  }

  now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  // ── persistence ──
  private load() {
    if (this.opts.file && existsSync(this.opts.file)) {
      this.state = JSON.parse(readFileSync(this.opts.file, 'utf8')) as FakeState;
    }
  }
  private save() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.opts.file);
  }
  /** Read-modify-write against the shared file (single host dev use). */
  mutate<T>(fn: (s: FakeState) => T): T {
    this.load();
    const r = fn(this.state);
    this.save();
    return r;
  }
  view<T>(fn: (s: FakeState) => T): T {
    this.load();
    return fn(this.state);
  }

  // ── scenario setup ──
  ensureSource(ref: string, readable = true) {
    this.mutate((s) => {
      s.sources[ref] ??= { readable, posts: [] };
      s.sources[ref].readable = readable;
    });
  }
  ensureAccount(externalId: string) {
    this.mutate((s) => {
      s.accounts[externalId] ??= { externalId, session: 'OK', timeline: [] };
    });
  }
  setSession(externalId: string, session: FakeAccount['session']) {
    this.mutate((s) => {
      s.accounts[externalId].session = session;
    });
  }
  setLoggedInAs(externalId: string, other: string | undefined) {
    this.mutate((s) => {
      s.accounts[externalId].loggedInAs = other;
    });
  }
  addSourcePost(ref: string, p: Omit<FakeSourcePost, 'seq' | 'editSeq' | 'postedAt' | 'id'> & { id?: string; postedAt?: Date }): FakeSourcePost {
    return this.mutate((s) => {
      s.sources[ref] ??= { readable: true, posts: [] };
      const seq = s.nextSeq++;
      const post: FakeSourcePost = {
        ...p,
        id: p.id ?? `${ref}-p${seq}`,
        seq,
        editSeq: seq,
        postedAt: (p.postedAt ?? this.now()).toISOString(),
      };
      s.sources[ref].posts.push(post);
      return post;
    });
  }
  editSourcePost(ref: string, id: string, text: string) {
    this.mutate((s) => {
      const p = s.sources[ref].posts.find((x) => x.id === id);
      if (!p) throw new Error(`no fake post ${id}`);
      p.text = text;
      p.editSeq = s.nextSeq++;
    });
  }
  timeline(externalId: string): FakeTimelinePost[] {
    return this.view((s) => s.accounts[externalId]?.timeline ?? []);
  }

  // ── faults ──
  inject(rule: FaultRule) {
    this.faults.push({ times: 1, ...rule });
  }
  clearFaults() {
    this.faults = [];
  }
  /** Consume a matching fault, if any. */
  takeFault(stage: FaultStage, match?: string): FaultAction | null {
    const i = this.faults.findIndex((f) => f.stage === stage && (!f.match || f.match === match));
    if (i < 0) return null;
    const f = this.faults[i];
    f.times = (f.times ?? 1) - 1;
    if (f.times <= 0) this.faults.splice(i, 1);
    return f.action;
  }
}

/** Deterministic fake media bytes for a reference. */
export function fakeMediaBytes(ref: string): Buffer {
  return Buffer.from(`FAKE-MEDIA:${ref}:${createHash('sha256').update(ref).digest('hex')}`);
}
