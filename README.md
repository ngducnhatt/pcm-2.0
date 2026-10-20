# PCM OpsFlow — Hệ thống vận hành PCM

Backend REST API cho quy trình **Kinh doanh → Kho → Kỹ thuật → Bảo hành → Giao hàng → Thanh toán → Hoàn tất**, chạy trên Windows/XAMPP với Next.js App Router + MySQL/MariaDB.

- Dữ liệu và nghiệp vụ là ưu tiên số 1: state machine tuần tự, khóa đơn hàng chống ghi đè, tồn kho chống bán quá (atomic dưới khóa), serial được gắn chính xác khi xuất kho.
- Ứng dụng **chỉ lắng nghe 127.0.0.1:3000**. MySQL **không bao giờ mở ra Internet**. Muốn truy cập từ xa, dùng Cloudflare Tunnel, Caddy hoặc Tailscale (xem mục 8).
- Không dùng Docker, không có database ngoài.

Tài liệu API chi tiết: [`docs/API.md`](docs/API.md).

---

## 1. Yêu cầu hệ thống

| Thành phần | Yêu cầu |
|---|---|
| Hệ điều hành | Windows 10/11 hoặc Windows Server 2019+ |
| Node.js | **22 LTS trở lên** (đã kiểm thử với 22 và 26) |
| Database | XAMPP (MariaDB 10.4+) hoặc MySQL 8.0+ |
| Dung lượng | Đủ chỗ cho `node_modules`, bản build và thư mục `backups/` |
| Khác | Không cần Docker. Không cần mở cổng 3306 ra ngoài. |

Kiểm tra nhanh:

```powershell
node --version      # v22.x hoặc cao hơn
npm --version
C:\xampp\mysql\bin\mysql.exe --version
```

---

## 2. Cài đặt XAMPP và tạo database

### 2.1. Cài XAMPP

1. Tải XAMPP tại <https://www.apachefriends.org/> và cài vào `C:\xampp`.
2. Mở **XAMPP Control Panel**, bấm **Start** cho MySQL. Không cần Apache.
3. Đặt MySQL chạy như dịch vụ Windows nếu muốn tự khởi động: trong Control Panel, tick **Service** cạnh MySQL rồi Start.

Kiểm tra:

```powershell
C:\xampp\mysql\bin\mysql.exe -u root -e "SELECT VERSION();"
```

### 2.2. Tạo database và 3 tài khoản (khuyến nghị tách quyền)

Mở `cmd` và chạy `C:\xampp\mysql\bin\mysql.exe -u root -p`, sau đó dán (đổi mật khẩu mẫu!):

```sql
CREATE DATABASE pcm_opsflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Tài khoản chạy migration (có quyền DDL).
CREATE USER 'pcm_migrate'@'localhost' IDENTIFIED BY 'DoiMatKhauMigrate#2026';
CREATE USER 'pcm_migrate'@'127.0.0.1' IDENTIFIED BY 'DoiMatKhauMigrate#2026';
GRANT ALL PRIVILEGES ON pcm_opsflow.* TO 'pcm_migrate'@'localhost';
GRANT ALL PRIVILEGES ON pcm_opsflow.* TO 'pcm_migrate'@'127.0.0.1';

-- Tài khoản ứng dụng: chỉ đọc/ghi dữ liệu, KHÔNG có quyền DDL.
CREATE USER 'pcm_app'@'localhost' IDENTIFIED BY 'DoiMatKhauApp#2026';
CREATE USER 'pcm_app'@'127.0.0.1' IDENTIFIED BY 'DoiMatKhauApp#2026';
GRANT SELECT, INSERT, UPDATE, DELETE ON pcm_opsflow.* TO 'pcm_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON pcm_opsflow.* TO 'pcm_app'@'127.0.0.1';

-- Tài khoản chỉ đọc cho mysqldump.
CREATE USER 'pcm_backup'@'localhost' IDENTIFIED BY 'DoiMatKhauBackup#2026';
CREATE USER 'pcm_backup'@'127.0.0.1' IDENTIFIED BY 'DoiMatKhauBackup#2026';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON pcm_opsflow.* TO 'pcm_backup'@'localhost';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON pcm_opsflow.* TO 'pcm_backup'@'127.0.0.1';

FLUSH PRIVILEGES;
```

> Mật khẩu có ký tự đặc biệt phải **URL-encode** khi đưa vào `DATABASE_URL`. Ví dụ `P@ss#1` → `P%40ss%231`.

---

## 3. Cấu hình `.env.local`

Cài dependencies và tạo file cấu hình:

```powershell
npm ci
Copy-Item .env.example .env.local
notepad .env.local
```

Các biến quan trọng:

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Chuỗi kết nối runtime, ví dụ `mysql://pcm_app:...@127.0.0.1:3306/pcm_opsflow` |
| `MIGRATE_DATABASE_URL` | (Tùy chọn) tài khoản DDL cho `npm run db:migrate`. Bỏ trống thì dùng `DATABASE_URL` |
| `BACKUP_DATABASE_URL` | (Tùy chọn) tài khoản chỉ đọc cho `npm run db:backup` |
| `PG_POOL_MAX` | Số connection tối đa trong pool (mặc định 10) |
| `ADMIN_*` | Thông tin admin đầu tiên cho `npm run db:admin`; để trống `ADMIN_PASSWORD` để CLI hỏi kín |
| `APP_PUBLIC_URL` | Domain công khai, dùng kiểm tra Origin/CSRF |
| `TRUST_PROXY` | `true` **chỉ khi** app nằm sau Cloudflare Tunnel/Caddy/Tailscale trên cùng máy |
| `PROXY_MODE` | `cloudflare`, `caddy` hoặc `auto` |
| `COOKIE_SECURE` | `true` khi chạy HTTPS. **Không được để `false` khi mở Internet** |
| `SESSION_TTL_HOURS` | Thời hạn phiên (mặc định 12 giờ) |
| `MYSQLDUMP_PATH` | Đường dẫn `mysqldump.exe`, ví dụ `C:\xampp\mysql\bin\mysqldump.exe` |
| `BACKUP_DIR`, `BACKUP_KEEP` | Thư mục và số bản sao lưu giữ lại |
| `PORT`, `LOG_DIR`, `LOG_MAX_BYTES`, `LOG_KEEP_DAYS` | Cấu hình process runner |

`.env.local` đã nằm trong `.gitignore`. Không commit mật khẩu thật.

---

## 4. Migrate database và tạo admin đầu tiên

```powershell
npm run db:migrate
```

- Migration có số thứ tự trong `migrations/`, ghi lịch sử vào bảng `schema_migrations`, dùng `GET_LOCK` để không chạy trùng.
- Mỗi file chạy trong transaction, nhưng **MySQL/MariaDB tự động commit DDL**. Nếu migration lỗi giữa chừng, phải xử lý thủ công rồi chạy lại; đừng sửa file migration đã áp dụng (checksum sẽ chặn).

Tạo tài khoản quản trị đầu tiên (không có tài khoản mặc định trong mã nguồn):

```powershell
npm run db:admin
# hoặc không tương tác:
$env:ADMIN_PASSWORD='MatKhauRatManh#2026'; npm run db:admin; Remove-Item Env:ADMIN_PASSWORD
```

Mật khẩu phải dài tối thiểu 12 ký tự và có ít nhất 3 trong 4 nhóm: chữ thường, chữ hoa, số, ký tự đặc biệt.

Đổi mật khẩu bất kỳ qua CLI (thu hồi mọi phiên của người đó):

```powershell
npm run user:password -- --username admin
```

---

## 5. Build và chạy

```powershell
npm run build
npm run serve
```

`npm run serve` dùng `scripts/server-runner.mjs`:

- Chỉ bind `127.0.0.1:3000` (đổi qua `PORT` nếu cần).
- Ghi log vào `logs/app-YYYY-MM-DD.log`, xoay vòng theo ngày hoặc 10 MB, tự dọn log cũ hơn `LOG_KEEP_DAYS`.
- Tự khởi động lại Next.js nếu process con thoát bất thường (tối đa 8 lần liên tiếp).
- PID file `logs/pcm-opsflow.pid` ngăn chạy trùng instance.

Kiểm tra sức khỏe:

```powershell
npm run health
# [health] OK HTTP 200 sau 30 ms (schema=001, dbLatency=1 ms)
```

Chạy trực tiếp không qua runner (không có log xoay vòng/tự khởi động lại):

```powershell
npm start -- --hostname 127.0.0.1 --port 3000
```

> Tuyệt đối không đổi `--hostname` thành `0.0.0.0`. App phải đi qua reverse proxy/tunnel.

### Cấu trúc thư mục

```
app/                 Next.js App Router (UI tối giản + API route handlers)
lib/                 domain (state machine, roles), db adapter, auth, http, services
migrations/          file SQL đánh số
scripts/             migrate, db:admin, user:password, backup, runner, healthcheck
scripts/windows/     PowerShell cho Task Scheduler
deploy/              ví dụ Caddyfile và cloudflared config
tests/               test:flow (không cần DB) và test:auth (cần DB *_test)
logs/ backups/       sinh ra khi chạy (đã gitignore)
```

---

## 6. Nghiệp vụ và phân quyền tóm tắt

### 6.1. Vòng đời đơn

Mỗi bộ phận có 2 trạng thái: `*_PENDING` (chờ nhận) và `*_IN_PROGRESS` (đã nhận). Quy trình:

```
DRAFT → SALES_PENDING → SALES_IN_PROGRESS
      → WAREHOUSE_PENDING → WAREHOUSE_IN_PROGRESS   (giữ tồn kho khi chốt sales, xuất kho khi kho hoàn tất)
      → TECHNICAL_PENDING → TECHNICAL_IN_PROGRESS
      → WARRANTY_PENDING → WARRANTY_IN_PROGRESS
      → DELIVERY_PENDING → DELIVERY_IN_PROGRESS      (phân công shipper)
      → PAYMENT_PENDING → PAYMENT_IN_PROGRESS
      → COMPLETED
```

- Người xử lý phải **nhận đơn (CLAIM)** trước khi hoàn tất bước (trừ ADMIN).
- Hoàn tất bước sẽ xóa người nhận và chuyển đơn sang hàng đợi kế tiếp.
- **Hủy đơn** chỉ cho đến `DELIVERY_PENDING`:
  - Trước khi kho xuất: giải phóng lượng đang giữ.
  - Sau khi kho xuất, trước khi giao: hoàn kho và trả serial về `IN_STOCK`.
  - Sau khi giao/đã có thanh toán: không hủy tự động, phải xử lý hoàn tiền theo kế toán.
- Mọi thao tác đổi trạng thái đều cần `expectedVersion` (optimistic locking) và được ghi vào `order_events` + `audit_logs`.

### 6.2. Vai trò

| Vai trò | Quyền chính |
|---|---|
| `ADMIN` | Toàn quyền, xem tất cả, hủy ở mọi bước còn cho phép |
| `SALES` | Tạo/sửa đơn ở giai đoạn kinh doanh, chốt sales, hủy trong giai đoạn sales |
| `WAREHOUSE` | Nhận/xuất kho, điều chỉnh tồn kho, quản lý serial |
| `TECHNICIAN` | Nhận/hoàn tất bước kỹ thuật |
| `WARRANTY` | Nhận/hoàn tất bước bảo hành |
| `SHIPPING_MANAGER` | Phân công/đổi shipper, báo giao thất bại |
| `SHIPPER` | Chỉ thấy đơn được giao cho mình; xác nhận giao hoặc báo thất bại |
| `ACCOUNTANT` | Nhận bước thanh toán, ghi nhận thanh toán, xem đơn không nháp |

Dữ liệu khách hàng được che theo vai trò: kho/kỹ thuật không thấy SĐT/địa chỉ; shipper thấy địa chỉ nhưng không thấy giá vốn.

### 6.3. Tồn kho và serial

- Sản phẩm `serialRequired` bắt buộc gửi **đúng và đủ** danh sách serial khi kho hoàn tất; serial sai sản phẩm, đã bán hoặc trùng đều bị chặn.
- Tồn kho được khóa theo thứ tự `id` để tránh deadlock; mọi thay đổi đều ghi `inventory_movements`.
- Thanh toán là bản ghi **append-only**; hỗ trợ `idempotencyKey` chống ghi trùng khi mạng lỗi.

### 6.4. Tra cứu công khai

`GET /api/orders/track/{code}?phone=...` yêu cầu mã đơn có độ ngẫu nhiên cao và 4 số cuối SĐT (hoặc toàn bộ SĐT), chỉ trả trạng thái tối thiểu; có rate limit riêng; sai thông tin luôn trả 404 để không lộ sự tồn tại của đơn.

---

## 7. Kiểm thử

```powershell
npm run typecheck
npm run test:flow      # không cần database
npm run build
```

`test:auth` chỉ chạy trên database có tên kết thúc bằng `_test`:

```powershell
# tạo database test riêng (một lần)
C:\xampp\mysql\bin\mysql.exe -u root -p -e "CREATE DATABASE IF NOT EXISTS pcm_opsflow_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON pcm_opsflow_test.* TO 'pcm_migrate'@'localhost'; GRANT ALL PRIVILEGES ON pcm_opsflow_test.* TO 'pcm_migrate'@'127.0.0.1'; FLUSH PRIVILEGES;"

$env:DATABASE_URL='mysql://pcm_migrate:...@127.0.0.1:3306/pcm_opsflow_test'
npm run test:auth
Remove-Item Env:DATABASE_URL
```

Nếu MySQL không kết nối được, phần tích hợp sẽ tự bỏ qua nhưng test thuần (PBKDF2, cookie, CSRF) vẫn chạy. **Không bao giờ chạy `test:auth` trỏ vào database thật.**

---

## 8. Truy cập từ xa (chọn 1 trong 3)

App chỉ mở `127.0.0.1:3000`, vì vậy **không thể vào bằng `http://<IP-LAN>:3000`**. Hãy dùng một trong các cách dưới đây; cả ba đều giữ MySQL và app kín với Internet.

### Cách A — Cloudflare Tunnel (khuyến nghị)

Không cần mở cổng router, có HTTPS miễn phí.

1. Tải `cloudflared` cho Windows và đăng nhập: `cloudflared tunnel login`.
2. Tạo tunnel và DNS:
   ```powershell
   cloudflared tunnel create pcm-opsflow
   cloudflared tunnel route dns pcm-opsflow opsflow.example.com
   ```
3. Sao chép `deploy\cloudflared-config.example.yml` thành `C:\Users\<bạn>\.cloudflared\config.yml`, điền tunnel UUID và hostname.
4. Cài chạy nền: `cloudflared service install` (hoặc tạo Scheduled Task gọi `cloudflared tunnel run pcm-opsflow`).
5. Cập nhật `.env.local`:
   ```env
   APP_PUBLIC_URL=https://opsflow.example.com
   TRUST_PROXY=true
   PROXY_MODE=cloudflare
   COOKIE_SECURE=true
   ```
6. Khởi động lại `npm run serve`, mở `https://opsflow.example.com/api/health`.

### Cách B — Caddy (máy chủ có IP/domain công khai)

Caddy tự xin chứng chỉ Let's Encrypt và làm reverse proxy.

1. Tải Caddy, dùng `deploy\Caddyfile.example` làm mẫu, sửa domain.
2. Chạy Caddy như dịch vụ (`caddy run` khi thử, sau đó cài service bằng NSSM/Task Scheduler).
3. Cấu hình `.env.local`:
   ```env
   APP_PUBLIC_URL=https://opsflow.example.com
   TRUST_PROXY=true
   PROXY_MODE=caddy
   COOKIE_SECURE=true
   ```
4. Mở cổng **80/443** trên router/firewall; **không mở 3000 và 3306**.

### Cách C — Tailscale (mạng riêng, không cần domain)

1. Cài Tailscale trên máy chủ và các máy nhân viên, đăng nhập cùng tailnet.
2. Trên máy chủ chạy `tailscale serve --bg 3000` để proxy HTTPS vào `127.0.0.1:3000`.
3. Truy cập bằng `https://<tên-máy>.tailXXXX.ts.net`.
4. `.env.local`: `TRUST_PROXY=true`, `PROXY_MODE=auto`, `COOKIE_SECURE=true`, `APP_PUBLIC_URL` đặt bằng URL tailnet.

> **Lưu ý chung**
> - Nếu chưa có HTTPS, `COOKIE_SECURE=false` sẽ khiến cookie phiên bị trình duyệt chặn khi truy cập qua Internet. Đừng hạ chuẩn này trên môi trường thật.
> - Chỉ bật `TRUST_PROXY=true` khi mọi request đều đi qua proxy trên cùng máy; nếu không, kẻ tấn công có thể giả IP.
> - `TRUST_PROXY=true` + `PROXY_MODE=cloudflare` ưu tiên `CF-Connecting-IP`; `PROXY_MODE=caddy` ưu tiên `X-Real-IP` do Caddy tự ghi đè.

---

## 9. Tự khởi động, watchdog và vận hành

Chạy PowerShell **với quyền Administrator**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1
```

Script tạo 2 Scheduled Task chạy bằng tài khoản `SYSTEM`:

| Task | Lịch chạy | Việc làm |
|---|---|---|
| `PCM OpsFlow - Watchdog` | Khi khởi động máy + mỗi 5 phút | Kiểm tra `/api/health`; nếu lỗi thì dừng tiến trình cũ và khởi động lại runner |
| `PCM OpsFlow - Backup` | Hằng ngày 02:00 | Chạy `mysqldump`, kiểm tra file, ghi SHA-256 và dọn bản cũ |

Lệnh vận hành nhanh:

```powershell
# Chạy ngay không cần chờ
Start-ScheduledTask -TaskName 'PCM OpsFlow - Watchdog'

# Xem lần chạy gần nhất
Get-ScheduledTaskInfo -TaskName 'PCM OpsFlow - Watchdog'

# Chạy nền thủ công / dừng
powershell -ExecutionPolicy Bypass -File scripts\windows\start-pcm.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-pcm.ps1
```

Nên chạy `npm run serve` trong một cửa sổ riêng khi kiểm tra lần đầu để thấy lỗi trực tiếp, sau đó mới giao cho Scheduled Task.

---

## 10. Sao lưu và phục hồi

### 10.1. Sao lưu

```powershell
npm run db:backup
```

- File: `backups\pcm_opsflow_YYYYMMDD_HHMMSS.sql` kèm `.sha256`.
- Script từ chối file dump nhỏ hơn 1 KB hoặc thiếu `CREATE TABLE`.
- Tự xóa bản cũ, giữ `BACKUP_KEEP` bản mới nhất (mặc định 14).

Kiểm tra toàn vẹn:

```powershell
Get-FileHash -Algorithm SHA256 backups\pcm_opsflow_20261020_020000.sql
Get-Content backups\pcm_opsflow_20261020_020000.sql.sha256
```

### 10.2. Phục hồi

```powershell
# 1. Dừng app
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-pcm.ps1

# 2. Tạo lại database trống (cẩn thận: lệnh DROP xóa toàn bộ dữ liệu hiện tại)
C:\xampp\mysql\bin\mysql.exe -u root -p -e "DROP DATABASE IF EXISTS pcm_opsflow; CREATE DATABASE pcm_opsflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 3. Nạp bản sao lưu
cmd /c "C:\xampp\mysql\bin\mysql.exe -u root -p --default-character-set=utf8mb4 pcm_opsflow < backups\pcm_opsflow_20261020_020000.sql"

# 4. Áp dụng migration mới (nếu bản code hiện tại mới hơn bản backup)
npm run db:migrate

# 5. Chạy lại và kiểm tra
npm run serve
npm run health
```

Khuyến nghị: định kỳ phục hồi thử vào một database khác tên (`pcm_opsflow_restore_test`) để chắc chắn bản sao lưu dùng được.

---

## 11. Cập nhật phiên bản

```powershell
# 0. Thông báo người dùng, dừng app
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-pcm.ps1

# 1. Sao lưu trước khi cập nhật
npm run db:backup

# 2. Cập nhật mã nguồn (copy/giải nén bản mới, giữ nguyên .env.local)

# 3. Cài dependency và migrate
npm ci
npm run db:migrate

# 4. Build và chạy lại
npm run build
Start-ScheduledTask -TaskName 'PCM OpsFlow - Watchdog'
npm run health
```

Nếu lỗi: dừng app, khôi phục database từ backup, đưa mã nguồn về bản trước rồi build lại.

---

## 12. Log và giám sát

| File | Nội dung | Xoay vòng |
|---|---|---|
| `logs\app-YYYY-MM-DD.log` | stdout/stderr của Next.js (log JSON của ứng dụng) | 10 MB hoặc sang ngày mới, giữ `LOG_KEEP_DAYS` |
| `logs\watchdog.log` | lần restart, lỗi health | 5 MB |
| `logs\backup.log` | kết quả từng lần sao lưu | 5 MB |
| `logs\pcm-opsflow.pid` | PID runner đang chạy | xóa khi dừng |

Ứng dụng **không ghi mật khẩu, token phiên hay chuỗi kết nối** vào log. Khi báo lỗi cần hỗ trợ, gửi kèm vài dòng log gần nhất và mã đơn liên quan.

---

## 13. Bảo mật

- Mật khẩu băm bằng **PBKDF2-SHA256 210.000 vòng** (Web Crypto), salt riêng từng tài khoản.
- Phiên đăng nhập lưu dạng hash SHA-256; cookie `pcm_session` là `httpOnly`, `sameSite=lax`, `secure` khi HTTPS. Đổi mật khẩu/khóa tài khoản sẽ thu hồi phiên.
- Khóa đăng nhập sau **5 lần sai trong 15 phút**; rate limit theo IP (30/15 phút) và theo tài khoản (10/15 phút); tra cứu công khai 30/phút mỗi IP và 10/phút mỗi mã đơn.
- Kiểm tra `Origin`/`Sec-Fetch-Site` cho mọi request thay đổi dữ liệu (chống CSRF).
- Giới hạn kích thước body theo route (8 KB–512 KB) và trả lỗi 413 khi vượt.
- Header bảo mật: HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- Mọi thao tác nhạy cảm được ghi `audit_logs` kèm IP thật (lấy đúng sau proxy).
- MySQL chỉ nghe nội bộ; app chỉ bind loopback. Đừng mở cổng 3306.

---

## 14. Khắc phục sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `EADDRINUSE` khi chạy | Cổng 3000 đang bị chiếm | `netstat -ano \| findstr :3000`, dừng tiến trình hoặc đổi `PORT` |
| `/api/health` trả 503 | MySQL chưa chạy hoặc chưa migrate | Start MySQL trong XAMPP; chạy `npm run db:migrate` |
| `Access denied for user` | Sai mật khẩu hoặc chưa URL-encode | Kiểm tra `DATABASE_URL`; encode `@ # ! $ %` |
| `Cannot find module 'next'` | Chưa `npm ci` | Chạy `npm ci` trong thư mục dự án |
| Runner báo chưa build | Thiếu `.next\BUILD_ID` | Chạy `npm run build` |
| Đăng nhập xong bị đăng xuất ngay | `COOKIE_SECURE=true` nhưng đang vào bằng HTTP | Dùng HTTPS (tunnel/Caddy) hoặc tạm đặt `false` khi thử nội bộ |
| 403 khi gửi form | `Origin` không khớp `APP_PUBLIC_URL`/Host | Sửa `APP_PUBLIC_URL`, xóa cache, kiểm tra proxy ghi Host |
| 429 khi đăng nhập | Quá 5 lần sai hoặc vượt rate limit | Chờ 15 phút; admin mở khóa bằng `npm run user:password` hoặc API người dùng |
| Không hủy được đơn | Đơn đã qua `PAYMENT_PENDING` hoặc đã có thanh toán | Xử lý hoàn tiền thủ công theo quy trình kế toán |
| Kho báo thiếu tồn/thiếu serial | Số lượng giữ chưa đủ hoặc serial sai trạng thái | Kiểm tra `reserved_qty`, danh sách serial `IN_STOCK` |
| `mysqldump` không tìm thấy | Sai `MYSQLDUMP_PATH` | Trỏ đúng `C:\xampp\mysql\bin\mysqldump.exe` |
| Giờ trên đơn lệch | Múi giờ máy chủ khác UTC | App ghi UTC; hiển thị theo giờ Việt Nam ở phía giao diện |

Khi cần khởi động lại sạch:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-pcm.ps1
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'PCM OpsFlow - Watchdog'
npm run health
```

---

## 15. Lộ trình sử dụng API

1. `POST /api/auth/login` để lấy cookie phiên.
2. Tạo khách hàng `POST /api/customers` hoặc tạo đơn kèm khách mới `POST /api/orders`.
3. Dùng `/api/queues/{sales|warehouse|technical|warranty|delivery|payment}` để lấy hàng đợi.
4. `POST /api/orders/{id}/transitions` để nhận đơn và hoàn tất từng bước.
5. `POST /api/orders/{id}/payments` để ghi nhận thanh toán, sau đó `COMPLETE_PAYMENT`.
6. Giao diện tối giản tại `/` có thể dùng để thử toàn bộ luồng ngay trên trình duyệt.

Xem đầy đủ tham số, mã lỗi và ví dụ tại [`docs/API.md`](docs/API.md).
