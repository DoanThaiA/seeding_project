import { LoginForm } from './LoginForm';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  return (
    <main className="login">
      <div className="box">
        <h1>SeedingSys</h1>
        <p className="sub">Đăng nhập bằng mã truy cập do quản trị viên cấp.</p>
        {expired && <div className="alert warn" style={{ marginBottom: 12 }}>Phiên đã hết hạn hoặc mã không còn hiệu lực.</div>}
        <LoginForm />
      </div>
    </main>
  );
}
