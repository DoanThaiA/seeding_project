'use client';

import { useState } from 'react';
import { bff, useSubmit } from '@/components/client';

export function ConfirmPanel({ id }: { id: string }) {
  const [permalink, setPermalink] = useState('');
  const [note, setNote] = useState('');
  const found = useSubmit();
  const absent = useSubmit();
  return (
    <section className="card">
      <h2>Cần bạn xác nhận kết quả</h2>
      <p className="sub" style={{ marginBottom: 12 }}>Mở trang Facebook của tài khoản đích và kiểm tra xem bài đã được đăng chưa, rồi chọn một trong hai.</p>
      <div className="two">
        <div>
          <h2 style={{ fontSize: 14 }}>Bài đã có trên trang</h2>
          <div className="field">
            <label htmlFor="pl">Dán đường dẫn bài</label>
            <input id="pl" value={permalink} onChange={(e) => setPermalink(e.target.value)} placeholder="https://www.facebook.com/…" inputMode="url" />
          </div>
          <button className="primary" disabled={found.pending || !/^https?:\/\//.test(permalink)} onClick={() => found.run(() => bff('POST', `publications/${id}/confirm`, { permalink }), 'Đã ghi nhận')}>Xác nhận đã đăng</button>
          {found.error && <p className="err" role="alert">{found.error}</p>}
        </div>
        <div>
          <h2 style={{ fontSize: 14 }}>Chắc chắn chưa có bài</h2>
          <div className="field">
            <label htmlFor="nt">Ghi chú (bạn đã kiểm tra ở đâu)</label>
            <input id="nt" value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: đã xem dòng thời gian B1, không thấy bài" />
          </div>
          <button
            className="danger"
            disabled={absent.pending || note.trim().length < 3}
            onClick={() => {
              if (window.confirm('Xác nhận CHẮC CHẮN chưa có bài? Nội dung sẽ được xếp lịch đăng lại — nếu bài thật ra đã đăng sẽ bị trùng.')) absent.run(() => bff('POST', `publications/${id}/confirm-absent`, { note: note.trim() }), 'Đã ghi nhận');
            }}
          >
            Chưa đăng — cho phép đăng lại
          </button>
          {absent.error && <p className="err" role="alert">{absent.error}</p>}
        </div>
      </div>
    </section>
  );
}
