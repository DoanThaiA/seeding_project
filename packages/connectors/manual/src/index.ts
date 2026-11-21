import { ConnectorError, type ReadConnector, type ReadResult, type SourceRef } from '@seedingsys/connectors-core';
import type { ObjectStore } from '@seedingsys/storage';

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).map(([e, m]) => [m, e]));

/** Identify a media file from its bytes (never trust the client's declared type). */
export function sniffMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return b.subarray(8, 12).toString('latin1').startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  return null;
}

export const manualStagingKey = (batchId: string, index: number, mime: string) => `manual/${batchId}/${index}.${MIME_EXT[mime] ?? 'bin'}`;

/**
 * "Manual" source: nothing is polled. A person imports content the organisation is entitled to
 * reuse (API: POST /sources/:id/manual-posts); the file bytes are staged in object storage and
 * this connector hands them to asset.fetch like any other source.
 */
export class ManualReadConnector implements ReadConnector {
  readonly key = 'manual';
  readonly version = 'manual-1';
  constructor(private readonly store: ObjectStore) {}

  async readSince(_s: SourceRef, watermark: Record<string, unknown> | null): Promise<ReadResult> {
    return { posts: [], nextWatermark: watermark ?? {}, incomplete: [] };
  }

  async fetchMedia(media: { ref: string }): Promise<{ bytes: Buffer; mime: string }> {
    if (!/^manual\/[\w-]+\/\d+\.\w+$/.test(media.ref)) throw new ConnectorError('PERMANENT', 'invalid manual media reference');
    const bytes = await this.store.get(media.ref);
    const mime = EXT_MIME[media.ref.split('.').pop()!];
    if (!mime) throw new ConnectorError('PERMANENT', 'unknown manual media type');
    return { bytes, mime };
  }
}
