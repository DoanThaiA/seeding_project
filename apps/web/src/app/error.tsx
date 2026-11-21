'use client';

export default function PageError({ retry }: { retry: () => void }) {
  return (
    <main className="login">
      <section className="box" aria-labelledby="page-error-title">
        <h1 id="page-error-title">Không tải được trang</h1>
        <p className="muted">Thử tải lại. Nếu vẫn gặp lỗi, hãy kiểm tra API và PostgreSQL đang chạy.</p>
        <button className="primary" type="button" onClick={retry}>Thử lại</button>
      </section>
    </main>
  );
}
