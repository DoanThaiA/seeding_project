import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaFile } from '@seedingsys/connectors-core';
import type { PublishSnapshot } from '@seedingsys/contracts';
import { sha256 } from '@seedingsys/domain';
import type { ObjectStore } from '@seedingsys/storage';
import { ConnectorError } from '@seedingsys/connectors-core';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/**
 * Download the snapshot's media to a per-publication temp dir and verify every checksum and the
 * order before anything is put into a composer.
 */
export async function materializeMedia(store: ObjectStore, snapshot: PublishSnapshot, dir: string): Promise<MediaFile[]> {
  if (!snapshot.media.length) return [];
  await mkdir(dir, { recursive: true });
  const out: MediaFile[] = [];
  const sorted = [...snapshot.media].sort((a, b) => a.position - b.position);
  for (const [i, m] of sorted.entries()) {
    if (m.position !== i) throw new ConnectorError('PERMANENT', `media manifest has a gap at position ${i}`);
    const bytes = await store.get(m.objectKey);
    const sum = sha256(bytes);
    if (sum !== m.checksum) throw new ConnectorError('PERMANENT', `checksum mismatch for asset ${m.assetId}`);
    // The browser infers the upload's type from the file extension: without one, Facebook may reject it.
    const file = join(dir, `${String(i).padStart(3, '0')}-${m.checksum.slice(0, 12)}.${EXT[m.mime] ?? (m.kind === 'video' ? 'mp4' : 'jpg')}`);
    await writeFile(file, bytes);
    out.push({ position: i, checksum: sum, mime: m.mime, kind: m.kind, location: file });
  }
  return out;
}

export async function cleanupMedia(dir: string) {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
