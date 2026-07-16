# Unicorn Relay Agent

Agent chạy trên **máy thu server của mỗi chi nhánh**, giữ 1 kết nối socket.io tới backend và làm 2 việc trong LAN:

1. **`relay:wake`** — gửi magic packet Wake-on-LAN bật máy khách.
2. **`relay:probe`** — ping-probe kiểm tra máy bootrom còn sống hay đã bị cắt điện (backend dùng để đóng phiên sớm với nhãn `user_shutdown` / giữ phiên khi máy còn bật).

## Cài đặt (mỗi máy thu ngân)

1. Copy nguyên thư mục này vào `C:\Relay_Agent`.
2. Copy `.env.example` → `.env`, sửa cho ĐÚNG chi nhánh:
   - `SERVER_URL` — URL backend.
   - `AGENT_TOKEN` — phải khớp token phía server (server sẽ từ chối relay sai token).
   - `BRANCH_ID` — **id chi nhánh của máy này** (deploy nhầm branch = probe nhầm máy!).
3. Mở PowerShell **Administrator**:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Relay_Agent\setup_relay.ps1
   # Chống nhầm chi nhánh: setup_relay.ps1 -ExpectedBranchId 6
   ```

   Script sẽ: kiểm tra `.env` có `BRANCH_ID` → cài Node nếu thiếu (`-NodeMsiPath`) → `npm install` → tạo task **"Unicorn Relay Agent"** (`onstart`, `SYSTEM`, highest) chạy `node supervisor.js` → harden (restart-on-fail ×10/1phút, không giới hạn giờ chạy) → chạy task ngay.

## Resilience 4 lớp

socket.io tự reconnect → `supervisor.js` respawn relay khi chết (backoff 1s→30s, PID lock chống chạy đôi) → Task Scheduler restart ×10 khi task fail → trigger `onstart` chạy từ lúc boot, **không cần thu ngân login**.

## Vận hành

- Log: `logs\relay.log` (2MB ×3 backup) và `logs\supervisor.log`.
- Chạy tay để debug: `npm start` (relay trần) hoặc `npm run start:supervised`.
- Kiểm tra task: `schtasks /query /tn "Unicorn Relay Agent" /v /fo list`.
- Gỡ: `powershell -ExecutionPolicy Bypass -File uninstall_relay.ps1` (Admin).

## Ngữ nghĩa probe (đừng sửa nếu chưa đọc plan)

- `alive` = ping.exe exit 0 **và** stdout có `TTL=` (exit 0 khi "Destination host unreachable" là reply của gateway, không phải máy đích).
- `arpMac` chỉ đính kèm khi `alive=true` và `arp -a <ip>` parse được MAC (chuẩn hóa lowercase, `:`); backend dùng để xác minh đúng máy trả lời.
- `ok:false` (`no-ip` / `spawn-failed: ...`) = **không có phán quyết** — backend rơi về timer 7 phút như cũ.
- Mọi tham số (attempts 1..10, intervalMs 0..10000, timeoutMsPerPing 200..5000) đi trong payload từ server, relay chỉ clamp.

## Dev test (không cần backend)

```powershell
npm install   # cài kèm devDependency socket.io cho stub
node test\probe_server_stub.js 127.0.0.1 10 35001
# .env: SERVER_URL=http://127.0.0.1:35001 → node relay.js
```
