'use client';

import { useEffect, useState } from 'react';
import { bff } from '@/components/client';

type Friend = { name: string; url: string; birthYear: number | null; followers: string | null; score: number };
type Run = { id: string; status: string; message: string | null; profileUrl: string | null; limit: number; results: Friend[] };
type Runs = { login: Run | null; scan: Run | null };
const pending = (run: Run | null) => !!run && ['QUEUED', 'RUNNING', 'OPEN'].includes(run.status);
const statusText = (run: Run) => run.message ?? (run.status === 'QUEUED' ? 'Đang chờ máy worker…' : 'Đang xử lý…');

export function TargetBrowser({ targetId, disabled }: { targetId: string; disabled: boolean }) {
  const path = 'targets/' + targetId + '/browser';
  const [runs, setRuns] = useState<Runs>({ login: null, scan: null });
  const [profile, setProfile] = useState('');
  const [limit, setLimit] = useState('20');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const busy = pending(runs.login) || pending(runs.scan);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const res = await fetch('/bff/' + path, { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const data: Runs = await res.json();
        if (!stopped) { setRuns(data); setReadError(''); }
      } catch { if (!stopped) setReadError('Không tải được trạng thái trình duyệt.'); }
      if (!stopped) timer = setTimeout(refresh, busy ? 1800 : 8000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [path, busy, sending]);
  async function start(kind: keyof Runs) {
    setSending(true); setError('');
    const result = await bff<Run>('POST', path, kind === 'login' ? { kind } : { kind, profile, limit: Number(limit) });
    if (result.ok) setRuns(old => ({ ...old, [kind]: result.data }));
    else setError(result.error);
    setSending(false);
  }
  const locked = disabled || sending || busy;
  const scan = runs.scan;
  return <section>
    <button type="button" disabled={locked} onClick={() => void start('login')}>Đăng nhập Facebook</button>
    {runs.login && <p role="status">{statusText(runs.login)}</p>}
    <h3>Gom bạn bè từ hồ sơ</h3>
    <form onSubmit={e => { e.preventDefault(); void start('scan'); }}>
      <label className="field">Liên kết hoặc ID hồ sơ Facebook<input required value={profile} onChange={e => setProfile(e.target.value)} /></label>
      <label className="field">Số bạn bè tối đa<input type="number" required min={1} max={100} value={limit} onChange={e => setLimit(e.target.value)} /></label>
      <button type="submit" disabled={locked}>Quét bạn bè</button>
    </form>
    {(error || readError) && <p role="alert">{error || readError}</p>}
    {scan && <>
      <p><a href={scan.profileUrl!} target="_blank" rel="noreferrer">Hồ sơ nguồn</a> · {scan.results.length}/{scan.limit} hồ sơ</p>
      <p role="status">{statusText(scan)}</p>
      {!!scan.results.length && <>
        <p>Điểm đầy đủ trung bình {(scan.results.reduce((sum, r) => sum + r.score, 0) / scan.results.length).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}/3. Mỗi trường hiển thị được tính một điểm.</p>
        <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Tên và liên kết</th><th>Năm sinh</th><th>Người theo dõi</th><th>Điểm đầy đủ</th></tr></thead>
          <tbody>{scan.results.map(row => <tr key={row.url}><td><a href={row.url} target="_blank" rel="noreferrer">{row.name}</a></td>
            <td>{row.birthYear ?? '—'}</td><td>{row.followers ?? '—'}</td><td>{row.score}/3</td></tr>)}</tbody></table></div>
      </>}
    </>}
  </section>;
}
