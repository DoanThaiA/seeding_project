import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Media bytes live in object storage; the DB only keeps key + checksum + metadata. */
export interface ObjectStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  open(key: string, range?: { start: number; end: number }): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Short-lived URL (R2) or local path (dev) a worker host can download from. */
  locate(key: string, ttlSec?: number): Promise<string>;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** Content-addressed key: re-uploading the same bytes is idempotent. */
export function assetObjectKey(sha256: string, mime: string): string {
  return `assets/original/${sha256.slice(0, 2)}/${sha256}.${EXT[mime] ?? 'bin'}`;
}

export class LocalStore implements ObjectStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private p(key: string) {
    const full = resolve(this.root, key);
    const rel = relative(this.root, full);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('invalid object key');
    return full;
  }
  async put(key: string, bytes: Buffer) {
    const f = this.p(key);
    await mkdir(dirname(f), { recursive: true });
    const temp = f + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, bytes);
      await rename(temp, f);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async get(key: string) {
    return readFile(this.p(key));
  }
  async open(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.p(key), range);
  }
  async exists(key: string) {
    try {
      await stat(this.p(key));
      return true;
    } catch {
      return false;
    }
  }
  async locate(key: string) {
    return this.p(key);
  }
}

export class R2Store implements ObjectStore {
  private readonly s3: S3Client;
  constructor(private readonly cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key: string, bytes: Buffer, mime: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: bytes, ContentType: mime }));
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async open(key: string, range?: { start: number; end: number }) {
    const Range = range ? 'bytes=' + range.start + '-' + range.end : undefined;
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range }));
    if (!r.Body || !('pipe' in r.Body)) throw new Error('Object store did not return a readable stream');
    return r.Body;
  }
  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async locate(key: string, ttlSec = 600) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSec });
  }
}

export function createStore(cfg: {
  STORAGE_DRIVER: 'local' | 'r2';
  LOCAL_STORAGE_DIR: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
}): ObjectStore {
  if (cfg.STORAGE_DRIVER === 'r2') {
    return new R2Store({ accountId: cfg.R2_ACCOUNT_ID!, accessKeyId: cfg.R2_ACCESS_KEY_ID!, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY!, bucket: cfg.R2_BUCKET! });
  }
  return new LocalStore(cfg.LOCAL_STORAGE_DIR);
}
