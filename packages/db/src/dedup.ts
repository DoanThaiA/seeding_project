import { Prisma, type SourcePost, type VariantStatus } from '@prisma/client';
import { REVIEW_REASONS } from '@seedingsys/contracts';
import { contentKey, isFacebookTimelineReader, isSamePost, rebaseMediaRef, type PostFacts } from '@seedingsys/domain';
import { audit } from './audit';
import { closeVariantReviewTasks } from './operator-tasks';
import { moveVariant } from './transitions';

type Q = Prisma.TransactionClient;

// ───────────── one post, one record ─────────────

/** Readers whose post ids can change between reads (pfbid rotation, hash fallback ids). */
export const hasUnstablePostIds = (connector: string) => isFacebookTimelineReader(connector) || connector === 'fb-web';

/** The stored post for a platform id: its own id or an alias recorded when it was read again under another id. */
export async function findSourcePost(t: Q, sourceId: string, externalId: string): Promise<SourcePost | null> {
  const direct = await t.sourcePost.findUnique({ where: { sourceId_externalId: { sourceId, externalId } } });
  if (direct) return direct;
  const alias = await t.sourcePostAlias.findUnique({ where: { sourceId_externalId: { sourceId, externalId } }, include: { post: true } });
  return alias?.post ?? null;
}

interface ReadFacts {
  text: string;
  contentType: string;
  incomplete: string[];
  media: Array<{ ref: string }>;
  postedAt?: Date;
  raw?: Record<string, unknown>;
}

/** Readers only revisit the newest part of a timeline; older posts are reached by their date. */
const RECENT_CANDIDATES = 500;
const DATE_WINDOW_MS = 2 * 24 * 3_600_000;

/**
 * The stored post of this source that a read with an unknown id actually is (oldest match wins), or null.
 * Trashed posts are included on purpose: a rotated id must not bring a trashed post back.
 */
export async function findSamePost(t: Q, sourceId: string, read: ReadFacts): Promise<SourcePost | null> {
  const from = read.postedAt ? new Date(read.postedAt.getTime() - DATE_WINDOW_MS) : null;
  const to = read.postedAt ? new Date(read.postedAt.getTime() + DATE_WINDOW_MS) : null;
  const rows = await t.$queryRaw<Array<{ id: string; posted_at: Date | null; content_type: string; text: string; incomplete: unknown; raw: unknown; refs: Array<string | null> }>>`
    WITH candidates AS (
      (SELECT id FROM source_posts WHERE source_id = ${sourceId}::uuid ORDER BY first_seen_at DESC, id DESC LIMIT ${RECENT_CANDIDATES})
      UNION
      (SELECT id FROM source_posts WHERE source_id = ${sourceId}::uuid AND posted_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz)
      UNION
      (SELECT id FROM source_posts WHERE source_id = ${sourceId}::uuid AND is_pinned)
    )
    SELECT sp.id, sp.posted_at, sp.content_type::text AS content_type, r.text, r.incomplete, r.raw,
      COALESCE((SELECT array_agg(a.source_ref ORDER BY pa.position) FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.revision_id = r.id), '{}') AS refs
    FROM candidates c
    JOIN source_posts sp ON sp.id = c.id
    JOIN source_post_revisions r ON r.id = sp.latest_revision_id
    ORDER BY sp.first_seen_at ASC, sp.id ASC`;
  const incoming = facts({ text: read.text, contentType: read.contentType, flags: read.incomplete, refs: read.media.map(m => m.ref),
    postedAt: read.postedAt, raw: read.raw });
  const match = rows.find(row => isSamePost(incoming, facts({ text: row.text, contentType: row.content_type, flags: row.incomplete,
    refs: row.refs.filter((ref): ref is string => !!ref), postedAt: row.posted_at, raw: row.raw })));
  return match ? t.sourcePost.findUnique({ where: { id: match.id } }) : null;
}

function facts(p: { text: string; contentType: string; flags: unknown; refs: string[]; postedAt?: Date | null; raw: unknown }): PostFacts {
  const flags = Array.isArray(p.flags) ? p.flags as string[] : [];
  return {
    text: p.text, contentType: p.contentType, mediaRefs: p.refs, postedAt: p.postedAt ?? null,
    truncated: flags.includes('CAPTION_TRUNCATED'), incomplete: flags.length > 0,
    postedAtExact: (p.raw as { postedAtExact?: unknown } | null)?.postedAtExact === true,
  };
}

/** Remember that `externalId` is another id of `post`. */
export async function recordAlias(t: Q, args: { sourceId: string; externalId: string; post: SourcePost; actor: string; now: Date }): Promise<void> {
  await t.sourcePostAlias.createMany({ data: [{ sourceId: args.sourceId, externalId: args.externalId, sourcePostId: args.post.id, createdAt: args.now }], skipDuplicates: true });
  await audit(t, { entityType: 'source_post', entityId: args.post.id, action: 'alias_recorded', actor: args.actor, data: { externalId: args.externalId }, at: args.now });
}

/** A read under an alias id: re-home its media refs onto the stored id so an unchanged post hashes the same. */
export function onStoredId<T extends { externalId: string; media: Array<{ ref: string }> }>(read: T, post: SourcePost): T {
  if (read.externalId === post.externalId) return read;
  return { ...read, media: read.media.map(m => ({ ...m, ref: rebaseMediaRef(m.ref, read.externalId, post.externalId) })) };
}

// ───────────── one content, once per target ─────────────

/** Content key of a revision whose media is settled; computed and stored on first use. null = media not settled. */
export async function revisionContentKey(t: Q, revisionId: string): Promise<string | null> {
  const rev = await t.sourcePostRevision.findUnique({
    where: { id: revisionId },
    select: { contentKey: true, text: true, albumTitle: true, mediaStatus: true, assets: { select: { asset: { select: { status: true, checksum: true } } } } },
  });
  if (!rev) return null;
  if (rev.contentKey !== null) return rev.contentKey;
  if (rev.mediaStatus !== 'READY' && rev.mediaStatus !== 'NOT_REQUIRED') return null;
  if (rev.assets.some(a => a.asset.status !== 'STORED' || !a.asset.checksum)) return null;
  const key = contentKey({ text: rev.text, albumTitle: rev.albumTitle, checksums: rev.assets.map(a => a.asset.checksum!) });
  await t.sourcePostRevision.updateMany({ where: { id: revisionId, contentKey: null }, data: { contentKey: key } });
  return key;
}

/** Fill in content keys of settled revisions stored before keys existed (or settled outside ingest). */
export async function backfillContentKeys(t: Q, limit = 200): Promise<number> {
  const pending = await t.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM source_post_revisions WHERE content_key IS NULL AND media_status IN ('READY','NOT_REQUIRED') ORDER BY id LIMIT ${limit}`;
  let n = 0;
  for (const { id } of pending) if (await revisionContentKey(t, id) !== null) n++;
  return n;
}

/** Ready content always has settled media: make sure its key exists before a dispatch compares keys. */
export async function settleReadyContentKeys(t: Q, targetId: string): Promise<void> {
  const unkeyed = await t.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT r.id FROM content_variants v JOIN source_post_revisions r ON r.id = v.revision_id
    WHERE v.target_id = ${targetId}::uuid AND v.status = 'READY' AND r.content_key IS NULL`;
  for (const { id } of unkeyed) await revisionContentKey(t, id);
}

const WAITING: VariantStatus[] = ['REWRITING', 'VALIDATING', 'READY', 'NEEDS_REVIEW'];

/**
 * Who already holds a content for a target: another source post that has a publication there
 * (queued, running, unresolved or done), or that was collected earlier and is still waiting for it.
 */
function holderSql(target: Prisma.Sql, post: Prisma.Sql, key: Prisma.Sql, now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT p.source_post_id AS id FROM publications p
    JOIN content_variants pv ON pv.id = p.variant_id
    JOIN source_post_revisions pr ON pr.id = pv.revision_id
    WHERE p.target_id = ${target} AND p.source_post_id <> ${post} AND pr.content_key = ${key}
      AND p.status NOT IN ('FAILED_CONFIRMED', 'CANCELLED')
    UNION ALL
    SELECT o.source_post_id FROM content_variants o
    JOIN source_post_revisions orv ON orv.id = o.revision_id
    JOIN source_posts osp ON osp.id = o.source_post_id AND osp.archived_at IS NULL AND osp.latest_revision_id = o.revision_id
    JOIN source_posts me ON me.id = ${post}
    WHERE o.target_id = ${target} AND o.source_post_id <> ${post} AND orv.content_key = ${key}
      AND o.status IN ('REWRITING', 'VALIDATING', 'READY', 'NEEDS_REVIEW')
      AND (o.expires_at IS NULL OR o.expires_at > ${now})
      AND (osp.first_seen_at, osp.id) < (me.first_seen_at, me.id)
    LIMIT 1`;
}

/** The source post that already holds this content for the target, if any. */
export async function contentHolder(t: Q, args: { targetId: string; sourcePostId: string; contentKey: string | null; now: Date }): Promise<string | null> {
  if (!args.contentKey) return null;
  const rows = await t.$queryRaw<Array<{ id: string }>>(
    holderSql(Prisma.sql`${args.targetId}::uuid`, Prisma.sql`${args.sourcePostId}::uuid`, Prisma.sql`${args.contentKey}`, args.now));
  return rows[0]?.id ?? null;
}

/** Fields for a variant created as a duplicate (no rewrite, no review). */
export const duplicateVariant = { status: 'DUPLICATE' as const, reviewReasons: [REVIEW_REASONS.DUPLICATE] };

/** Mark one waiting variant as a duplicate of `holder`'s content. */
export async function markDuplicate(t: Q, args: { id: string; from: VariantStatus; holder: string; actor: string; now: Date }): Promise<boolean> {
  const moved = await moveVariant(t, {
    id: args.id, from: args.from, to: 'DUPLICATE', actor: args.actor, now: args.now,
    reason: `duplicate of source post ${args.holder}`, data: { reviewReasons: [REVIEW_REASONS.DUPLICATE] },
  });
  if (moved && args.from === 'NEEDS_REVIEW') await closeVariantReviewTasks(t, args.id, args.actor, args.now, 'duplicate_content');
  return moved;
}

/**
 * Waiting variants (not published, not in flight) whose content another source post already holds
 * for the same target become DUPLICATE. Idempotent; safe to run every tick and before each dispatch.
 */
export async function retireDuplicateVariants(t: Q, args: { now: Date; actor: string; targetId?: string; limit?: number }): Promise<number> {
  const target = args.targetId ? Prisma.sql`AND v.target_id = ${args.targetId}::uuid` : Prisma.empty;
  const rows = await t.$queryRaw<Array<{ id: string; status: VariantStatus; holder: string }>>`
    SELECT v.id, v.status::text AS status, h.id AS holder
    FROM content_variants v
    JOIN source_posts vsp ON vsp.id = v.source_post_id AND vsp.archived_at IS NULL AND vsp.latest_revision_id = v.revision_id
    JOIN source_post_revisions r ON r.id = v.revision_id AND r.content_key <> ''
    CROSS JOIN LATERAL (${holderSql(Prisma.sql`v.target_id`, Prisma.sql`v.source_post_id`, Prisma.sql`r.content_key`, args.now)}) h
    WHERE v.status::text IN (${Prisma.join(WAITING)}) ${target}
      AND (v.expires_at IS NULL OR v.expires_at > ${args.now})
      AND NOT EXISTS (
        SELECT 1 FROM publications own
        WHERE own.target_id = v.target_id AND own.source_post_id = v.source_post_id
          AND own.status NOT IN ('FAILED_CONFIRMED', 'CANCELLED'))
    ORDER BY vsp.first_seen_at, vsp.id
    LIMIT ${args.limit ?? 200}`;
  let n = 0;
  for (const row of rows) if (await markDuplicate(t, { ...row, from: row.status, actor: args.actor, now: args.now })) n++;
  return n;
}
