import { createHash, randomUUID } from 'node:crypto';
import {
  ConnectorError,
  type CapabilitySet,
  type CommitSignal,
  type DraftHandle,
  type MediaFile,
  type PreviewExpectation,
  type PublishConnector,
  type PublishSession,
  type ReadConnector,
  type ReadResult,
  type SourceRef,
  type TargetRef,
  type VerifyHint,
  type VerifyResult,
  type ConnectorErrorKind,
} from '@seedingsys/connectors-core';
import { FAKE_PUBLISH_FORMATS, type IncompleteFlag, type PublishSnapshot } from '@seedingsys/contracts';
import { FakePlatform, fakeMediaBytes, type FaultAction } from './platform';

export * from './platform';

const VERSION = 'fake-1.0.0';

function fp(caption: string) {
  return createHash('sha256').update(caption.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

const hang = () => new Promise<never>(() => undefined);

async function applyFault(a: FaultAction | null): Promise<void> {
  if (!a) return;
  if (a.kind === 'hang') {
    a.onEnter?.();
    await hang();
  }
  if (a.kind === 'gate') {
    a.onEnter?.();
    await a.wait;
  }
  if (a.kind === 'throw') throw new ConnectorError(a.errorKind as ConnectorErrorKind, `injected ${a.errorKind}`, a.sideEffectPossible ?? false);
}

export class FakeReadConnector implements ReadConnector {
  readonly key = 'fake';
  readonly version = VERSION;
  constructor(private readonly p: FakePlatform) {}

  async readSince(source: SourceRef, watermark: Record<string, unknown> | null, overlap: number): Promise<ReadResult> {
    await applyFault(this.p.takeFault('read', source.externalRef));
    const src = this.p.view((s) => s.sources[source.externalRef]);
    if (!src || !src.readable) throw new ConnectorError('SOURCE_UNREADABLE', `source ${source.code} not readable`);
    const last = Number((watermark as { lastSeq?: number } | null)?.lastSeq ?? 0);
    // newest first, like a timeline; include posts edited after the watermark
    const ordered = [...src.posts].sort((a, b) => b.seq - a.seq);
    const fresh = ordered.filter((p) => p.seq > last || p.editSeq > last);
    const maxPosts = source.history ? undefined : source.maxPosts;
    const changeSeq = (post: (typeof src.posts)[number]) => Math.max(post.seq, post.editSeq);
    // In a capped incremental poll, commit the oldest changes first so advancing the sequence does not skip posts.
    const selected = maxPosts === undefined ? fresh : (watermark ? fresh.sort((a, b) => changeSeq(a) - changeSeq(b)) : fresh).slice(0, maxPosts);
    const remaining = maxPosts === undefined ? overlap : Math.min(overlap, maxPosts - selected.length);
    const overlapPosts = ordered.filter((p) => p.seq <= last && p.editSeq <= last).slice(0, remaining);
    const posts = [...selected, ...overlapPosts].map((p) => ({
      externalId: p.id,
      identityConfidence: 'HIGH' as const,
      permalink: `fake://${source.externalRef}/${p.id}`,
      postedAt: new Date(p.postedAt),
      text: p.text,
      albumTitle: p.albumTitle,
      contentType: p.contentType,
      isPinned: !!p.isPinned,
      isShared: !!p.isShared,
      media: p.media.map((m) => ({ kind: m.kind, ref: m.ref, expectedChecksum: createHash('sha256').update(fakeMediaBytes(m.ref)).digest('hex') })),
      incomplete: (p.incomplete ?? []) as IncompleteFlag[],
    }));
    const pending = !!watermark && selected.length < fresh.length;
    const maxSeq = (pending ? selected : src.posts).reduce((m, p) => Math.max(m, changeSeq(p)), last);
    return { posts, nextWatermark: { lastSeq: maxSeq }, incomplete: pending ? ['PAGINATION_INCOMPLETE'] : [] };
  }

  async fetchMedia(media: { ref: string }): Promise<{ bytes: Buffer; mime: string }> {
    await applyFault(this.p.takeFault('fetchMedia', media.ref));
    return { bytes: fakeMediaBytes(media.ref), mime: media.ref.includes('video') ? 'video/mp4' : 'image/jpeg' };
  }
}

class FakeSession implements PublishSession {
  private drafts = new Map<string, { snapshot: PublishSnapshot; media: MediaFile[] }>();
  constructor(
    private readonly p: FakePlatform,
    private readonly target: TargetRef,
  ) {}

  private acct() {
    const a = this.p.view((s) => s.accounts[this.target.externalId]);
    if (!a) throw new ConnectorError('SESSION_LOGGED_OUT', 'no such fake account');
    return a;
  }

  async sessionState() {
    return this.acct().session;
  }

  async checkIdentity(expected: string) {
    const observed = this.acct().loggedInAs ?? this.acct().externalId;
    return { ok: observed === expected, observed };
  }

  async prepare(snapshot: PublishSnapshot, media: MediaFile[]): Promise<DraftHandle> {
    await applyFault(this.p.takeFault('prepare', this.target.externalId));
    const id = randomUUID();
    this.drafts.set(id, { snapshot, media });
    return { id };
  }

  async previewCheck(draft: DraftHandle, exp: PreviewExpectation) {
    const f = this.p.takeFault('preview', this.target.externalId);
    await applyFault(f);
    const d = this.drafts.get(draft.id);
    if (!d) throw new ConnectorError('UI_UNEXPECTED', 'draft lost');
    const problems: string[] = [];
    if (f?.kind === 'previewMismatch' || d.snapshot.caption !== exp.caption) problems.push('caption mismatch');
    if (d.media.length !== exp.mediaCount) problems.push('media count mismatch');
    if (d.media.map((m) => m.checksum).join() !== exp.mediaChecksums.join()) problems.push('media order/checksum mismatch');
    const audienceOk = f?.kind !== 'audienceMismatch' && this.target.audience === exp.audience;
    return { ok: problems.length === 0 && audienceOk, problems, audienceOk };
  }

  async commit(draft: DraftHandle): Promise<CommitSignal> {
    const d = this.drafts.get(draft.id);
    if (!d) throw new ConnectorError('UI_UNEXPECTED', 'draft lost');
    await applyFault(this.p.takeFault('commit.before', this.target.externalId));
    const after = this.p.takeFault('commit.after', this.target.externalId);
    const isVideo = d.snapshot.contentType === 'VIDEO' || d.snapshot.contentType === 'REEL';
    const postId = `${this.target.externalId}_${randomUUID().slice(0, 8)}`;
    if (after?.kind !== 'dropPost') {
      this.p.mutate((s) => {
        s.accounts[this.target.externalId].timeline.push({
          id: postId,
          caption: d.snapshot.caption,
          mediaChecksums: d.media.map((m) => m.checksum),
          audience: this.target.audience,
          albumTitle: d.snapshot.albumTitle,
          at: this.p.now().toISOString(),
          processingUntil: isVideo ? new Date(this.p.now().getTime() + 1).toISOString() : undefined,
        });
      });
    }
    this.drafts.delete(draft.id);
    // The post exists now; a failure here is a failure *after* the side effect.
    await applyFault(after && after.kind !== 'dropPost' ? after : null);
    return after?.kind === 'dropPost' ? {} : { permalink: `fake://${this.target.externalId}/posts/${postId}`, externalPostId: postId };
  }

  async waitProcessing(_signal: CommitSignal, heartbeat: () => Promise<void>) {
    await heartbeat();
    await applyFault(this.p.takeFault('processing', this.target.externalId));
  }

  async verify(hint: VerifyHint): Promise<VerifyResult> {
    const f = this.p.takeFault('verify', this.target.externalId);
    await applyFault(f);
    if (f?.kind === 'verifyNotFound') return { kind: 'NOT_FOUND', conclusive: false };
    const from = hint.committedAt.getTime() - hint.windowMs;
    const to = hint.committedAt.getTime() + hint.windowMs;
    const matches = this.acct().timeline.filter(
      (p) => fp(p.caption) === hint.captionFingerprint && p.mediaChecksums.length === hint.mediaCount && +new Date(p.at) >= from && +new Date(p.at) <= to,
    );
    if (f?.kind === 'verifyAmbiguous' || matches.length > 1) return { kind: 'AMBIGUOUS', matches: Math.max(matches.length, 2) };
    if (matches.length === 1) {
      return { kind: 'VERIFIED', permalink: `fake://${this.target.externalId}/posts/${matches[0].id}`, externalPostId: matches[0].id, evidence: { at: matches[0].at } };
    }
    return { kind: 'NOT_FOUND', conclusive: true, evidence: { scanned: this.acct().timeline.length } };
  }

  async discardDraft(draft: DraftHandle) {
    this.drafts.delete(draft.id);
  }

  async close() {
    this.drafts.clear();
  }
}

export class FakePublishConnector implements PublishConnector {
  readonly key = 'fake';
  readonly version = VERSION;
  constructor(private readonly p: FakePlatform) {}

  capabilities(_t: TargetRef): CapabilitySet {
    return { ...Object.fromEntries(FAKE_PUBLISH_FORMATS.map(format => [format, true])), NAMED_ALBUM: false, REEL: false };
  }

  async openSession(target: TargetRef): Promise<PublishSession> {
    return new FakeSession(this.p, target);
  }
}
