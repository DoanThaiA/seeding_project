/**
 * Check object storage settings: write, read back, verify and delete a small test object.
 *   pnpm check:storage
 * Never prints keys.
 */
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@seedingsys/config';
import { createStore } from '@seedingsys/storage';

async function main() {
  const cfg = loadConfig();
  console.log(`Driver: ${cfg.STORAGE_DRIVER}${cfg.STORAGE_DRIVER === 'r2' ? ` · bucket: ${cfg.R2_BUCKET}` : ` · thư mục: ${cfg.LOCAL_STORAGE_DIR}`}`);
  if (cfg.STORAGE_DRIVER === 'r2') {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.R2_ACCESS_KEY_ID!, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY! },
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: cfg.R2_BUCKET }));
      console.log('✓ Kết nối được và thấy bucket');
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      const code = err.$metadata?.httpStatusCode;
      const hint =
        code === 404 ? 'bucket không tồn tại trong tài khoản này' :
        code === 403 ? 'khóa không có quyền với bucket này (sai khóa hoặc khóa giới hạn bucket khác)' :
        code === 401 ? 'khóa không hợp lệ' :
        'không kết nối được (kiểm tra Account ID)';
      throw new Error(`✗ Không truy cập được bucket: ${hint} [${err.name ?? 'Error'}${code ? ` ${code}` : ''}]`);
    }
  }
  const store = createStore(cfg);
  const key = `healthcheck/${randomUUID()}.bin`;
  const body = Buffer.from(`seedingsys storage check ${new Date().toISOString()}`);
  await store.put(key, body, 'application/octet-stream');
  console.log('✓ Ghi được');
  const back = await store.get(key);
  if (!back.equals(body)) throw new Error('✗ Đọc lại không khớp nội dung');
  console.log('✓ Đọc lại đúng nội dung');
  if (!(await store.exists(key))) throw new Error('✗ Không thấy tệp vừa ghi');
  const url = await store.locate(key, 60);
  console.log(`✓ Tạo được đường dẫn tải về tạm thời (${cfg.STORAGE_DRIVER === 'r2' ? 'URL ký hạn 60 giây' : 'đường dẫn cục bộ'})`);
  if (cfg.STORAGE_DRIVER === 'r2') {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.R2_ACCESS_KEY_ID!, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY! },
    });
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.R2_BUCKET, Key: key }));
    const res = await fetch(url).catch(() => null);
    console.log(`✓ Đã xóa tệp thử${res ? ` (truy cập lại trả về ${res.status})` : ''}`);
  }
  console.log('\nLưu trữ hoạt động bình thường.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
