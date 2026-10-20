# PCM OpsFlow — API Reference

Base URL nội bộ: `http://127.0.0.1:3000`. Khi triển khai, dùng domain HTTPS qua Cloudflare Tunnel/Caddy/Tailscale.

Mọi request/response dùng JSON UTF-8. Các endpoint thay đổi dữ liệu yêu cầu tiêu đề `Origin` hợp lệ (CSRF) và (trừ login) cookie phiên `pcm_session`.

---

## 1. Quy ước chung

### 1.1. Định dạng phản hồi

Thành công:

```json
{ "data": { }, "meta": { "page": 1, "limit": 20, "total": 42, "pages": 3 } }
```

Lỗi:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Đơn hàng đã được người khác cập nhật. Vui lòng tải lại.",
    "details": { "currentVersion": 7 }
  }
}
```

| Mã HTTP | `error.code` | Ý nghĩa |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `PAYLOAD_TOO_LARGE` | Dữ liệu sai hoặc body quá lớn |
| 401 | `UNAUTHORIZED` | Chưa đăng nhập/hết phiên |
| 403 | `FORBIDDEN` | Sai vai trò, sai Origin, hoặc không phải người đang xử lý |
| 404 | `NOT_FOUND` | Không tồn tại hoặc bị che theo quyền xem |
| 409 | `CONFLICT` / `DUPLICATE` | Xung đột phiên bản, tồn kho, trùng dữ liệu |
| 413 | `PAYLOAD_TOO_LARGE` | Vượt giới hạn body của route |
| 422 | `VALIDATION_ERROR` | Zod không chấp nhận dữ liệu |
| 429 | `RATE_LIMITED` / `LOGIN_UNAVAILABLE` | Quá nhanh hoặc tài khoản tạm khóa |
| 500 | `INTERNAL_ERROR` | Lỗi hệ thống, cần xem log |

### 1.2. Optimistic locking

Mọi thao tác sửa đơn/sản phẩm/thanh toán đều cần `expectedVersion` (số nguyên ≥ 0). Nếu dữ liệu đã đổi, API trả **409** kèm `currentVersion`. Luôn gửi lại giá trị `version` mới nhất nhận được.

### 1.3. Rate limit

| Phạm vi | Giới hạn |
|---|---|
| Đăng nhập theo IP | 30 lần / 15 phút |
| Đăng nhập theo tài khoản/email | 10 lần / 15 phút |
| Tra cứu công khai theo IP | 30 lần / phút |
| Tra cứu công khai theo mã đơn | 10 lần / phút |

Tài khoản bị khóa đăng nhập 15 phút sau **5 lần sai mật khẩu**.

### 1.4. Ví dụ đăng nhập bằng curl

```powershell
curl.exe -s -c cookies.txt -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3000" `
  -d '{\"identifier\":\"admin\",\"password\":\"MatKhau123#\"}' `
  http://127.0.0.1:3000/api/auth/login
```

Các request sau dùng `-b cookies.txt`.

---

## 2. Xác thực và tài khoản

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | Công khai | `{ identifier, password }`; đặt cookie `pcm_session` |
| POST | `/api/auth/logout` | Phiên | Thu hồi phiên hiện tại, xóa cookie |
| GET | `/api/auth/me` | Phiên | Thông tin người dùng và hạn phiên |
| POST | `/api/auth/change-password` | Phiên | `{ currentPassword, newPassword }`; thu hồi các phiên khác |
| GET | `/api/meta` | Phiên | Danh mục vai trò, bộ phận, trạng thái, hành động + nhãn tiếng Việt |

Ví dụ phản hồi `GET /api/auth/me`:

```json
{
  "data": {
    "id": "1",
    "username": "admin",
    "email": "admin@example.com",
    "fullName": "Quản trị viên PCM",
    "role": "ADMIN",
    "roleLabel": "Quản trị hệ thống",
    "sessionExpiresAt": "2026-10-20T20:00:00.000Z"
  }
}
```

---

## 3. Đơn hàng

### 3.1. Vòng đời và hành động

| Action | Từ trạng thái | Sang trạng thái | Ghi chú |
|---|---|---|---|
| `SUBMIT` | `DRAFT` | `SALES_PENDING` | SALES/ADMIN |
| `CLAIM` | `*_PENDING` (trừ DELIVERY) | `*_IN_PROGRESS` | Đúng bộ phận; đơn chưa có người nhận |
| `RELEASE` | `*_IN_PROGRESS` (trừ DELIVERY) | `*_PENDING` | Người đang xử lý hoặc ADMIN |
| `COMPLETE_SALES` | `SALES_IN_PROGRESS` | `WAREHOUSE_PENDING` | Bắt buộc `note`; giữ tồn kho |
| `COMPLETE_WAREHOUSE` | `WAREHOUSE_IN_PROGRESS` | `TECHNICAL_PENDING` | Bắt buộc `note`; xuất kho + gắn serial |
| `COMPLETE_TECHNICAL` | `TECHNICAL_IN_PROGRESS` | `WARRANTY_PENDING` | Bắt buộc `note` |
| `COMPLETE_WARRANTY` | `WARRANTY_IN_PROGRESS` | `DELIVERY_PENDING` | Bắt buộc `note` |
| `ASSIGN_SHIPPER` | `DELIVERY_PENDING` | `DELIVERY_IN_PROGRESS` | SHIPPING_MANAGER/ADMIN; cần `shipperId` |
| `REASSIGN_SHIPPER` | `DELIVERY_IN_PROGRESS` | `DELIVERY_IN_PROGRESS` | Đổi shipper đang giao |
| `DELIVERY_FAILED` | `DELIVERY_IN_PROGRESS` | `DELIVERY_PENDING` | Cần `failureReason` |
| `COMPLETE_DELIVERY` | `DELIVERY_IN_PROGRESS` | `PAYMENT_PENDING` | SHIPPER được giao hoặc ADMIN; cần `receiverName` |
| `COMPLETE_PAYMENT` | `PAYMENT_IN_PROGRESS` | `COMPLETED` | Đơn phải đã thanh toán đủ; tính `warrantyUntil` |
| `CANCEL` | Tới `DELIVERY_PENDING` | `CANCELLED` | Cần `cancelReason`; SALES chỉ trong giai đoạn sales |

Quy tắc bổ sung:

- ADMIN được hoàn tất bước mà không cần `CLAIM`; các vai trò khác phải là người đang xử lý.
- SHIPPER chỉ xác nhận đơn có `assignedTo.id` là mình.
- `COMPLETE_WAREHOUSE` với sản phẩm `serialRequired=true` phải gửi `serials` đúng số lượng cho từng dòng hàng.
- Hủy sau khi kho xuất (từ `TECHNICAL_PENDING` đến `DELIVERY_PENDING`) sẽ hoàn kho và trả serial về `IN_STOCK`.
- Không hủy được đơn đã có thanh toán.

### 3.2. Danh sách endpoint

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/orders` | Phiên (theo phạm vi vai trò) | Danh sách có lọc |
| POST | `/api/orders` | SALES, ADMIN | Tạo đơn (có thể `submit: false` để lưu nháp) |
| GET | `/api/orders/{id}` | Phiên trong phạm vi xem | Chi tiết đơn (đã che dữ liệu theo vai trò) |
| PATCH | `/api/orders/{id}` | SALES, ADMIN | Sửa đơn trong giai đoạn kinh doanh; cần `expectedVersion` |
| POST | `/api/orders/{id}/transitions` | Theo bảng hành động | Đổi trạng thái; cần `expectedVersion` |
| GET | `/api/orders/{id}/history` | Phiên trong phạm vi xem | Lịch sử sự kiện, phân trang |
| POST | `/api/orders/{id}/notes` | Phiên trong phạm vi xem | `{ body, visibility }` với `ALL`/`DEPARTMENT`/`PRIVATE` |
| POST | `/api/orders/{id}/payments` | ACCOUNTANT, ADMIN | Ghi nhận thanh toán (append-only) |
| GET | `/api/orders/track/{code}?phone=...` | Công khai | Tra cứu tối thiểu |

Tham số `GET /api/orders`: `page`, `limit` (≤100), `status`, `q`, `assigned=me|all`, `priority`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `sort=newest|oldest|priority|updated`.

Tham số `GET /api/orders/{id}/history`: `page`, `limit`.

### 3.3. Tạo đơn

```json
{
  "customerId": "12",
  "items": [
    { "productId": "5", "quantity": 2, "unitPrice": "1250000.00", "notes": "Màu đen" },
    { "name": "Phí lắp đặt", "quantity": 1, "unitPrice": "200000.00" }
  ],
  "discountAmount": "50000.00",
  "shippingFee": "30000.00",
  "priority": "HIGH",
  "expectedDeliveryDate": "2026-11-01",
  "warrantyMonths": 12,
  "note": "Giao giờ hành chính",
  "submit": true
}
```

- Truyền `customerId` **hoặc** `customer` (`fullName`, `phone`, `address`, `email?`, `note?`), không truyền cả hai.
- Hàng nhập tay cần `name` và `unitPrice`; hàng có `productId` mặc định lấy giá bán nếu bỏ trống.
- Một `productId` chỉ xuất hiện một lần trong `items`.
- `submit: true` (mặc định) đưa đơn vào hàng đợi sales; `false` tạo nháp.
- Tiền là chuỗi thập phân tối đa 2 chữ số sau dấu phẩy.

### 3.4. Đổi trạng thái

```json
{
  "action": "COMPLETE_WAREHOUSE",
  "expectedVersion": 4,
  "note": "Xuất đủ 2 thiết bị",
  "serials": [
    { "orderItemId": "31", "serialNumbers": ["SN-A001", "SN-A002"] }
  ]
}
```

Các trường theo hành động: `shipperId` (ASSIGN/REASSIGN), `receiverName` + `proofNote` (COMPLETE_DELIVERY), `failureReason` (DELIVERY_FAILED), `cancelReason` (CANCEL), `note` (bắt buộc ≥ 3 ký tự với các bước hoàn tất).

### 3.5. Ghi nhận thanh toán

```json
{
  "expectedVersion": 9,
  "amount": "2000000.00",
  "method": "BANK_TRANSFER",
  "reference": "FT261020123456",
  "note": "Khách chuyển khoản đủ",
  "idempotencyKey": "order-42-payment-1"
}
```

- `method`: `CASH`, `BANK_TRANSFER`, `CARD`, `COD`, `OTHER`.
- Gửi lại cùng `idempotencyKey` trả về `meta.duplicate = true` và **không** tạo bản ghi mới.
- Số tiền không được vượt quá số còn phải thu; đơn có tổng 0 không cần thanh toán.

### 3.6. Tra cứu công khai

`GET /api/orders/track/PCM-261020-A1B2C3D4?phone=5678`

Phản hồi chỉ gồm: `code`, `status`, `statusLabel`, `departmentLabel`, `updatedAt`, `expectedDeliveryDate`, `shippedAt`, `deliveredAt`, `completedAt`. Sai mã hoặc sai số điện thoại đều trả 404.

---

## 4. Hàng đợi và tổng quan

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/queues/{department}` | Vai trò thuộc bộ phận (ADMIN tất cả) | Hàng đợi hiện tại |
| GET | `/api/dashboard` | Phiên | Số đơn theo trạng thái, hàng đợi được phép xem, thông báo chưa đọc, doanh thu (nếu có quyền) |

`department` ∈ `sales`, `warehouse`, `technical`, `warranty`, `delivery`, `payment`.

Tham số queue: `page`, `limit`, `q`, `sort=newest|oldest|priority`, `includeDrafts=true|false` (chỉ sales). SHIPPER chỉ thấy đơn `DELIVERY_IN_PROGRESS` được giao cho mình.

---

## 5. Khách hàng

| Method | Path | Quyền |
|---|---|---|
| GET | `/api/customers` | ADMIN, SALES |
| POST | `/api/customers` | ADMIN, SALES |
| GET | `/api/customers/{id}` | ADMIN, SALES |
| PATCH | `/api/customers/{id}` | ADMIN, SALES |

Body tạo: `{ fullName, phone, email?, address, note? }`. Số điện thoại được chuẩn hóa và dùng để tránh tạo trùng; bản ghi `isActive=false` không dùng được trong đơn mới.

Tham số danh sách: `q`, `active=true|false`, `page`, `limit`.

---

## 6. Sản phẩm, tồn kho, serial

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/products` | Phiên | Danh sách; `costPrice` chỉ ADMIN/ACCOUNTANT thấy |
| POST | `/api/products` | ADMIN | Tạo sản phẩm |
| GET | `/api/products/{id}` | Phiên | Chi tiết |
| PATCH | `/api/products/{id}` | ADMIN | Sửa; cần `expectedVersion` |
| POST | `/api/products/{id}/adjustments` | ADMIN, WAREHOUSE | Nhập/xuất điều chỉnh; cần `expectedVersion` |
| GET | `/api/products/{id}/serials` | ADMIN, SALES, WAREHOUSE, TECHNICIAN, WARRANTY | Danh sách serial |

Tạo sản phẩm:

```json
{
  "sku": "CAM-IP-2MP",
  "name": "Camera IP 2MP",
  "unit": "cái",
  "costPrice": "800000.00",
  "salePrice": "1250000.00",
  "minStock": 5,
  "serialRequired": true
}
```

Điều chỉnh kho:

```json
{
  "expectedVersion": 0,
  "quantityDelta": 2,
  "reason": "Nhập kho đầu kỳ",
  "serialNumbers": ["SN-A001", "SN-A002"]
}
```

- Sản phẩm `serialRequired=true`: `quantityDelta > 0` phải kèm đúng số serial mới; `quantityDelta < 0` phải kèm đúng serial đang `IN_STOCK` (chuyển sang `DEFECTIVE`).
- Không thể giảm quá số khả dụng (`stock_qty - reserved_qty`).
- Không đổi `serialRequired` khi sản phẩm còn tồn kho.

Tham số serial: `q`, `status=IN_STOCK|RESERVED|SOLD|DEFECTIVE`, `page`, `limit`.

---

## 7. Người dùng (ADMIN)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/users` | Danh sách; lọc `q`, `role`, `active`, `page`, `limit` |
| POST | `/api/users` | `{ username, email, fullName, password, role }` |
| GET | `/api/users/{id}` | Chi tiết |
| PATCH | `/api/users/{id}` | `{ email?, fullName?, role?, isActive? }` |
| POST | `/api/users/{id}/reset-password` | `{ newPassword }`; thu hồi mọi phiên của người đó |

Không thể tự khóa/hạ quyền chính mình hoặc admin hoạt động cuối cùng. Đổi vai trò/khóa tài khoản thu hồi phiên ngay lập tức.

---

## 8. Thông báo và nhật ký

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/notifications` | Phiên | `unread=true|false`, `page`, `limit`; `meta.unread` là tổng chưa đọc |
| POST | `/api/notifications/{id}/read` | Phiên | Đánh dấu đã đọc |
| POST | `/api/notifications/read-all` | Phiên | Đánh dấu tất cả đã đọc |
| GET | `/api/audit-logs` | ADMIN | Lọc `action`, `entityType`, `actorId`, `orderId`, `from`, `to`, `page`, `limit` |

---

## 9. Sức khỏe hệ thống

`GET /api/health` — công khai, không cần đăng nhập.

```json
{
  "status": "ok",
  "service": "pcm-opsflow",
  "database": "up",
  "schemaVersion": "001",
  "migrations": 1,
  "dbLatencyMs": 1,
  "time": "2026-10-20T08:30:00.000Z",
  "uptimeSeconds": 120
}
```

Trả **503** khi MySQL lỗi hoặc chưa migrate (`schema_migrations` rỗng). Khi triển khai công khai, nên chặn `/api/health` ở tầng proxy như ví dụ Caddy và chỉ giám sát qua loopback.

---

## 10. Phạm vi xem theo vai trò

| Vai trò | Phạm vi |
|---|---|
| ADMIN, SALES | Tất cả đơn |
| ACCOUNTANT | Tất cả đơn không phải `DRAFT` |
| WAREHOUSE | Đơn `WAREHOUSE_PENDING` / `WAREHOUSE_IN_PROGRESS` |
| TECHNICIAN | Đơn `TECHNICAL_PENDING` / `TECHNICAL_IN_PROGRESS` |
| WARRANTY | Đơn `WARRANTY_PENDING` / `WARRANTY_IN_PROGRESS` |
| SHIPPING_MANAGER | Đơn `DELIVERY_PENDING` / `DELIVERY_IN_PROGRESS` |
| SHIPPER | Chỉ đơn `DELIVERY_IN_PROGRESS` được giao cho mình |

Trường bị che: kho/kỹ thuật/bảo hành không thấy SĐT, địa chỉ, email, giá; shipper thấy địa chỉ/SĐT nhưng không thấy tiền; chỉ ADMIN/SALES/ACCOUNTANT thấy đầy đủ tài chính và metadata sự kiện.
