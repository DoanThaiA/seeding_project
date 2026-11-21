# Triển khai SeedingSys

> Connector đăng bài `fb-web` mặc định chỉ cho phép định dạng đã đạt capability test ở chế độ “Chỉ mình tôi”. Nguồn A có thể dùng `fb-public` để quét từ URL trang cá nhân hoặc fanpage xem được ở chế độ khách. [Hướng dẫn cấu hình Facebook](FB-WEB.md)

## 1. Chọn cách chạy

| Cách | Khi nào | Cần |
|---|---|---|
| **A. Chạy trên máy của bạn** (không Docker) | Thử, nghiệm thu, đào tạo người vận hành | Node 20.19+, corepack |
| **B. Máy chủ thật** (Docker Compose) | Vận hành thường trực | 1 máy core (~4 vCPU/8 GB), 1 máy worker (~8 vCPU/32 GB), tên miền, Cloudflare R2, tài khoản Claude API |

## 2. Cách A — chạy trên máy của bạn

```powershell
cd C:\Users\ha\seeding_project
corepack enable          # một lần; nếu PowerShell chặn pnpm.ps1: Set-ExecutionPolicy -Scope Process Bypass
pnpm install
pnpm db:local            # terminal 1: PostgreSQL local (giữ mở)
```

Terminal 2 (lần đầu):

```powershell
$env:DATABASE_URL="postgresql://seedingsys:seedingsys@127.0.0.1:54329/seedingsys"; pnpm db:generate; pnpm db:migrate; pnpm db:seed
pnpm dev:all             # api + 3 worker + web
```

Mở **http://localhost:3000**, đăng nhập bằng một trong các mã trong `API_TOKENS` của file `.env` (mặc định `dev-admin-token`, `dev-reviewer-token`, `dev-operator-token`).

**Trước khi cho người khác dùng, đổi mã trong `.env`:**

```powershell
node scripts/gen-secrets.mjs --print
```

Dán các mã vừa in vào `API_TOKENS='{"<mã admin>":"admin","<mã duyệt>":"reviewer","<mã vận hành>":"operator"}'`, rồi chạy lại `pnpm dev:all`.

Thêm bài thử: `pnpm fake post A1 "nội dung"`.

## 3. Cách B — máy chủ thật

### 3.1 Chuẩn bị
- Máy Linux có Docker + Docker Compose v2 (core) và một máy khác cho worker. Tên miền trỏ A record về máy core (ví dụ `ops.congty.vn`).
- WireGuard giữa core và worker (core dùng địa chỉ `10.88.0.1`). **Postgres chỉ lắng nghe trên địa chỉ WireGuard**, không mở ra internet.
- Bucket R2 **private** + khóa truy cập; tài khoản Claude API.
- Chỉ mở cổng 80/443 (Caddy) và WireGuard ra ngoài. API không được công khai.

### 3.2 Máy core

```bash
git clone <repo> seedingsys && cd seedingsys
node scripts/gen-secrets.mjs      # tạo .env.core với mật khẩu Postgres + 4 mã đăng nhập (in ra MỘT lần — lưu vào trình quản lý mật khẩu)
nano .env.core                    # điền DOMAIN, ANTHROPIC_API_KEY, R2_*, kiểm tra APP_ENV
docker compose -f infra/compose/core.yml --env-file .env.core up -d --build
docker compose -f infra/compose/core.yml --env-file .env.core logs -f api worker-core
```

Compose tự chạy migration trước khi bật api/worker. Caddy tự xin chứng chỉ HTTPS cho `DOMAIN`. Đăng nhập tại `https://<DOMAIN>`.

### 3.3 Máy worker
1. Cài WireGuard, kiểm tra `ping 10.88.0.1`.
2. Trên core, tạo role DB giới hạn cho máy này (chỉ cần đọc/ghi các bảng nghiệp vụ, không cần superuser) và điền vào `DATABASE_URL` của `.env.worker`.
3. `cp .env.worker.example .env.worker`, điền thông tin. **Không** đặt `ANTHROPIC_API_KEY` hay `API_TOKENS` ở đây.
4. Thư mục profile (`PROFILES_DIR`) nằm trên **ổ đĩa mã hóa**, không đồng bộ lên cloud.
5. `docker compose -f infra/compose/worker.yml --env-file .env.worker up -d --build`.

> `infra/Dockerfile.worker` cài Chromium cho `fb-web` nhưng **chưa được build thử** (máy phát triển không có Docker): build một lần trên máy worker và chạy `pnpm fb:login` / `pnpm fb:capability` để kiểm tra. Xvfb/noVNC (tiếp quản từ xa) chưa có: hiện đăng nhập/xử lý checkpoint bằng cách ngồi trực tiếp tại máy worker hoặc dùng điều khiển từ xa của hệ điều hành.

### 3.4 Sao lưu & vận hành
- Sao lưu Postgres **ra ngoài máy** hằng ngày (ví dụ `pg_dump` lên R2/ổ khác) và diễn tập khôi phục trước khi chạy thật.
- Nâng cấp: `git pull && docker compose ... up -d --build` (migration tự chạy).
- Khôi phục sau mất điện: các dịch vụ tự khởi động lại (`restart: unless-stopped`); slot quá hạn được bỏ, không chạy bù.

## 4. Người dùng web và quyền

| Vai trò | Làm được |
|---|---|
| `admin` | Mọi thứ + trang Cấu hình |
| `reviewer` | Duyệt/loại/viết lại bài |
| `operator` | Xử lý việc tiếp quản, xác nhận kết quả, công tắc dừng |
| `viewer` | Chỉ xem |

Mỗi người một mã riêng nếu có thể (thêm vào `API_TOKENS`). Mã được lưu trong cookie `httpOnly`, không lộ cho script trên trang. Đổi hoặc thu hồi mã: sửa `API_TOKENS` rồi khởi động lại `api`.

## 5. Kiểm tra sau khi triển khai

- [ ] Đăng nhập được; mã sai bị từ chối; truy cập `/` khi chưa đăng nhập bị chuyển về `/login`.
- [ ] Tổng quan: 5/5 nguồn đọc ổn, heartbeat của máy core và worker < 2 phút.
- [ ] Thêm bài thử vào nguồn → thấy ở Duyệt bài hoặc Lịch & backlog sau tối đa 5 phút.
- [ ] Bật rồi tắt công tắc dừng một tài khoản; xác nhận dashboard phản ánh.
- [ ] `https://<DOMAIN>:3001` **không** truy cập được từ internet.
- [ ] Diễn tập khôi phục DB từ bản sao lưu.

## 6. Còn thiếu để đăng lên Facebook thật

1. Giai đoạn 0 (người làm): quyền sử dụng nội dung, văn bản đồng ý của chủ B1–B5, cố định locale `vi-VN` và đối tượng xem, người phụ trách checkpoint.
2. **Kiểm chứng selector trên giao diện thật và chạy capability test** (≥20 ca mỗi định dạng ở “Chỉ mình tôi”) — từng bước ở [FB-WEB.md](FB-WEB.md). Khi chưa có bản ghi đạt, bộ lập lịch **không giao việc** cho định dạng đó.
3. Build và kiểm tra image worker có Chromium trên máy worker thật.
4. Chuyển mã video (FFmpeg), agent xử lý ngoại lệ UI, tiếp quản qua noVNC.
5. Soak 7 ngày trước khi chuyển `APP_ENV=pilot-live` và đổi đối tượng xem sang thật.

Tự động hóa tài khoản cá nhân có thể đi ngược điều khoản của nền tảng và dẫn tới hạn chế tài khoản. Hệ thống dừng và chuyển cho người khi gặp checkpoint, không cố vượt qua.
