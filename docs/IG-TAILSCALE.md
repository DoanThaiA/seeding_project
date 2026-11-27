# Quét bài Instagram và mở dashboard qua Tailscale

## Dùng lõi đọc trong Chrome

Module `extension/research/instagram.mjs` chạy trong extension Chrome có quyền `scripting`, `storage` và quyền truy cập `https://www.instagram.com/*`. Caller cấp URL bài hoặc profile người dùng đã chọn. Đây là module để tích hợp vào extension, chưa có màn hình quét trong dashboard.

Để liệt kê bài trên profile, gọi `scanInstagramStep({id, url, limit, checkpoint}, deadline, sameUid)` trong service worker. `deadline` là thời điểm hết hạn theo millisecond Unix. `sameUid` là callback bất đồng bộ kiểm tra profile vẫn đúng. Giữ cùng `id`, lưu `report` khi có và truyền lại làm `checkpoint` khi `pending` bằng true. Khi kết thúc, gọi `closeInstagramResearchTab(id)`. Các hàng kết quả nằm ở `report.rows`.

Để đọc một bài đã mở, import `readInstagram` và chạy đoạn sau trong service worker với tab và URL của chính bài đó.

```js
const [execution] = await chrome.scripting.executeScript({
  target: { tabId },
  func: readInstagram,
  args: ['post', url, 1, Date.now() + 30_000, null, null, null],
});
const report = execution.result;
```

`body` chứa caption và `instagramMedia` chứa các liên kết ảnh hoặc video đọc được. Kiểm tra `issue`, `captionPartial` và `mediaPartial` trước khi sử dụng kết quả.

## Mở dashboard từ máy khác

1. Khởi động dashboard theo `docs/DEPLOY.md`. Xác định cổng web đang dùng và đặt mã đăng nhập riêng trong cấu hình trước khi chia sẻ.
2. Cài Tailscale trên máy chủ và thiết bị điều khiển. Đăng nhập vào cùng mạng riêng hoặc cấp quyền truy cập máy chủ cho người dùng trên thiết bị kia.
3. Trên máy chủ chạy `tailscale serve --bg http://127.0.0.1:3000`. Thay 3000 bằng cổng dashboard thực tế. Nếu Tailscale yêu cầu bật HTTPS, làm theo liên kết do lệnh cung cấp. Với truy cập HTTPS, đặt `WEB_INSECURE_COOKIE=0` và khởi động lại web để áp dụng.
4. Chạy `tailscale serve status`, mở URL HTTPS hiển thị từ thiết bị kia và kiểm tra đăng nhập dashboard. API và database vẫn dùng địa chỉ nội bộ. Hai thiết bị có thể ở khác Wi-Fi.

Tài liệu Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
