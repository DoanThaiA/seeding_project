'use client';

import { useEffect, useRef, useState } from 'react';
import { bff } from '@/components/client';

export type PostSnapshot = { previewId?: string; url: string; author: string | null; caption: string;
  capturedAt: string; imageCount?: number };
export type GeneratedDraft = { name: string; steps: { targetId: string; text: string; replyTo: number | null }[] };

type JobStatus<T> = { status: 'DONE' } & ({ post: T } | { draft: T })
  | { status: 'FAILED'; error: string }
  | { status: 'QUEUED' | 'RUNNING' };

export function useCommentJob<T>() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function run(path: string, body: unknown) {
    if (active.current) return null;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    try {
      const started = await bff<{ id: string }>('POST', path, body);
      if (!started.ok) throw new Error(started.error);
      for (let checks = 0; checks < 330 && !controller.signal.aborted; checks++) {
        const response = await fetch(`/bff/${path}/${started.data.id}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          if (response.status === 401) window.location.href = '/login?expired=1';
          throw new Error('Chưa kiểm tra được kết quả. Hãy thử lại.');
        }
        const job = await response.json() as JobStatus<T>;
        if (job.status === 'DONE') return 'post' in job ? job.post : job.draft;
        if (job.status === 'FAILED') throw new Error(job.error);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error('Đã hết thời gian chờ. Hãy thử lại.');
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Thao tác chưa hoàn tất.');
      return null;
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return { run, pending, error, clearError: () => setError(null) };
}

export function PostContent({ post }: { post: PostSnapshot }) {
  return <div className="workflow-step workflow-stack">
    <div className="workflow-toolbar">
      <h3>Nội dung bài viết</h3>
      <a href={post.url} target="_blank" rel="noreferrer">Mở bài Facebook</a>
    </div>
    {post.author && <strong>{post.author}</strong>}
    {post.caption ? <p className="workflow-message">{post.caption}</p> : <p className="muted">Bài viết không có phần chữ.</p>}
    {!!post.imageCount && <p className="muted">Đã lấy {post.imageCount} ảnh của bài · AI đọc cả ảnh khi viết bình luận.</p>}
  </div>;
}
