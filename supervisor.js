// Điểm chạy NGƯỜI GÁC (supervisor): giữ `node relay.js` LUÔN sống.
// Chạy cái NÀY thay vì chạy trực tiếp relay.js:
//     node supervisor.js
// Task Scheduler (setup_relay.ps1) trỏ vào file này: /sc onstart /ru SYSTEM
// → tự bật lúc boot, chạy cả khi máy thu ngân CHƯA login.
//
//  - Spawn relay.js làm con, con chết thì respawn (backoff ở lib/supervisor.js).
//  - Single-instance: chỉ 1 supervisor được chạy (tránh 2 relay cùng register).
//  - Log riêng logs/supervisor.log (không lẫn vào relay.log).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createFileLogger } = require("./lib/fileLogger");
const { createSupervisor } = require("./lib/supervisor");

const LOGS_DIR = path.join(__dirname, "logs");
const LOCK_FILE = path.join(LOGS_DIR, "supervisor.lock");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const { log } = createFileLogger({ filePath: path.join(LOGS_DIR, "supervisor.log") });

// ─── Single-instance ────────────────────────────────────────────────
// Lock file lưu PID. Nếu PID cũ còn sống VÀ đúng là node.exe → đã có supervisor → thoát.
// PHẢI xác minh image name: sau cắt điện / taskkill /F, lock còn sót và Windows có thể
// TÁI CẤP PID đó cho tiến trình khác lúc boot — nếu tin mù kill(pid,0), supervisor thật
// thoát với exit 0 ("thành công") nên Task Scheduler không bao giờ restart → cả chi nhánh
// mất relay (probe lẫn WoL) đến lần reboot may mắn hơn.
function isOurSupervisorAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = chỉ kiểm tra tồn tại
  } catch (e) {
    if (e.code !== "EPERM") return false; // ESRCH: PID chết → lock stale
    // EPERM: tồn tại nhưng khác quyền — vẫn phải xác minh image name bên dưới.
  }
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 5000, encoding: "utf8" },
    );
    return /"node\.exe"/i.test(out); // PID bị tái cấp cho tiến trình khác → stale
  } catch {
    return true; // không xác minh được → an toàn kiểu cũ: coi như sống, không chạy đôi
  }
}

try {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid && isOurSupervisorAlive(oldPid)) {
      log(`[supervisor] Đã có supervisor chạy (PID ${oldPid}) — thoát.`);
      process.exit(0);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  log(`[supervisor] Lỗi xử lý lock file (bỏ qua, vẫn chạy): ${e.message}`);
}

// ─── Khởi động người gác ────────────────────────────────────────────
const sup = createSupervisor({
  script: path.join(__dirname, "relay.js"),
  log,
});
sup.start();

// ─── Dừng gọn khi bị stop (Task Scheduler End / Ctrl+C / shutdown) ───
let cleaned = false;
function cleanup(signal) {
  if (cleaned) return;
  cleaned = true;
  log(`[supervisor] Nhận ${signal} — dừng relay rồi thoát.`);
  sup.stop(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
  // Cho relay chút thời gian nhận tín hiệu & dọn dẹp rồi mới thoát hẳn.
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("SIGBREAK", () => cleanup("SIGBREAK"));
process.on("SIGHUP", () => cleanup("SIGHUP"));
process.on("exit", () => {
  // Chốt chặn: xóa lock nếu còn (trường hợp thoát không qua cleanup).
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
});
