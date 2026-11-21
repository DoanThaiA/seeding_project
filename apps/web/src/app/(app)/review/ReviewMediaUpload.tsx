'use client';

import { useSubmit } from '@/components/client';

export function ReviewMediaUpload({ id, video }: { id: string; video: boolean }) {
  const submit = useSubmit();
  return (
    <details>
      <summary>Bổ sung media gốc</summary>
      <form onSubmit={e => {
        e.preventDefault();
        const body = new FormData(e.currentTarget);
        submit.run(async () => {
          try {
            const response = await fetch('/bff/review/' + id + '/media', { method: 'POST', headers: { 'x-requested-with': 'seedingsys' }, body });
            if (response.status === 401) window.location.href = '/login?expired=1';
            if (response.ok) return { ok: true };
            const { message } = await response.json().catch(() => ({})) as { message?: string | string[] };
            return { ok: false, error: Array.isArray(message) ? message.join(', ') : message ?? 'Không lưu được media' };
          } catch {
            return { ok: false, error: 'Không kết nối được máy chủ' };
          }
        }, 'Đã lưu media gốc');
      }}>
        <label htmlFor={'media-' + id}>{video ? 'Video gốc' : 'Toàn bộ ảnh theo thứ tự gốc'}</label>
        <input id={'media-' + id} name="media" type="file" accept={video ? 'video/mp4,video/quicktime' : 'image/jpeg,image/png,image/webp,image/gif'} multiple={!video} required />
        <label><input type="checkbox" name="completeOriginal" value="true" required /> Tôi xác nhận đây là media gốc đầy đủ.</label>
        <button type="submit" className="sm" disabled={submit.pending}>{submit.pending ? 'Đang lưu…' : 'Lưu media'}</button>
        {submit.error && <p className="err" role="alert">{submit.error}</p>}
        {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
      </form>
    </details>
  );
}
