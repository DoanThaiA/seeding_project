import type { ReactNode } from 'react';
import { label, tone } from '@/lib/format';

export function Badge({ s, text }: { s: string; text?: string }) {
  return <span className={`badge ${tone(s)}`}>{text ?? label(s)}</span>;
}

export function Kpi({ value, label: l, kind }: { value: ReactNode; label: string; kind?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`kpi ${kind ?? ''}`}>
      <div className="v">{value}</div>
      <div className="l">{l}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Head({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
