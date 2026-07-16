// NGƯỜI GÁC (supervisor) giữ `node relay.js` LUÔN sống.
// Spawn relay.js làm tiến trình CON; con thoát vì BẤT KỲ lý do gì (crash, bị
// taskkill, OOM lúc máy load nặng) thì respawn ngay. Có BACKOFF chống crash-loop:
// nếu relay chết quá nhanh liên tiếp, giãn dần thời gian chờ để supervisor khỏi
// quay điên cuồng đốt CPU; relay chạy đủ lâu (khỏe) thì reset về nhịp nhanh.
//
// Tách khỏi relay.js: relay lo NGHIỆP VỤ (WoL, ping-probe...), module này CHỈ lo
// VÒNG ĐỜI tiến trình — nên vừa tái dùng được vừa dễ test.
// Không tự bảo đảm được chính mình sống (tiến trình chết thì hết code chạy); đó là
// việc của lớp ngoài (Task Scheduler onstart/SYSTEM + restart-on-fail).

const { spawn } = require("child_process");
const path = require("path");

/**
 * Tạo supervisor giữ 1 script Node luôn sống.
 * @param {Object} opts
 * @param {string} opts.script - đường dẫn file cần giữ sống (vd .../relay.js).
 * @param {string} [opts.nodeExe] - node.exe dùng để spawn (mặc định node đang chạy).
 * @param {string} [opts.cwd] - thư mục làm việc của con (mặc định = thư mục của script).
 * @param {(...args:any[]) => void} [opts.log] - logger.
 * @param {number} [opts.minHealthyMs=60000] - con sống >= ngần này coi là "khỏe" → reset backoff.
 * @param {number} [opts.baseBackoffMs=1000] - chờ tối thiểu trước khi respawn.
 * @param {number} [opts.maxBackoffMs=30000] - trần backoff khi crash-loop.
 */
function createSupervisor({
  script,
  nodeExe = process.execPath,
  cwd,
  log = () => {},
  minHealthyMs = 60_000,
  baseBackoffMs = 1_000,
  maxBackoffMs = 30_000,
} = {}) {
  if (!script) throw new Error("createSupervisor: cần truyền script");
  const workDir = cwd || path.dirname(script);

  let child = null;
  let stopping = false;      // đã yêu cầu dừng hẳn → KHÔNG respawn nữa
  let backoff = baseBackoffMs;
  let startedAt = 0;
  let restarts = 0;
  let restartTimer = null;

  // Hẹn respawn (idempotent: đang hẹn rồi thì bỏ qua, tránh spawn 2 con).
  function scheduleRespawn(uptimeMs, reason) {
    if (stopping || restartTimer) return;
    // Sống đủ lâu = khỏe → nhịp nhanh lại. Chết nhanh = crash-loop → giãn backoff.
    backoff = uptimeMs >= minHealthyMs ? baseBackoffMs : Math.min(backoff * 2, maxBackoffMs);
    restarts += 1;
    log(`[supervisor] ${reason} → respawn sau ${backoff}ms (đã restart ${restarts} lần)`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, backoff);
  }

  function spawnChild() {
    if (stopping) return;
    startedAt = Date.now();
    // stdio "inherit": console của relay chảy ra nơi supervisor chạy (Task Scheduler
    // có thể redirect ra file). Relay vẫn tự ghi logs/relay.log như cũ.
    child = spawn(nodeExe, [script], { cwd: workDir, stdio: "inherit", windowsHide: false });

    child.once("spawn", () => {
      log(`[supervisor] Đã bật relay — PID ${child.pid}`);
    });

    child.on("error", (err) => {
      // Spawn thất bại (vd sai đường dẫn node): 'exit' sẽ KHÔNG fire → tự hẹn respawn.
      log(`[supervisor] Lỗi spawn relay: ${err.message}`);
      if (!child || child.pid === undefined) {
        child = null;
        scheduleRespawn(0, "Spawn thất bại");
      }
    });

    child.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      child = null;
      if (stopping) {
        log(`[supervisor] Relay thoát (code=${code} signal=${signal}) — đang dừng theo yêu cầu, KHÔNG respawn`);
        return;
      }
      const upSec = Math.round(uptimeMs / 1000);
      scheduleRespawn(uptimeMs, `Relay chết (code=${code} signal=${signal}, sống ${upSec}s)`);
    });
  }

  return {
    /** Bắt đầu giám sát: spawn relay + tự respawn khi chết. */
    start() {
      if (child || restartTimer) {
        log("[supervisor] Đã đang chạy, bỏ qua start() trùng");
        return;
      }
      stopping = false;
      log(`[supervisor] Giữ "${path.basename(script)}" luôn sống (backoff ${baseBackoffMs}–${maxBackoffMs}ms)`);
      spawnChild();
    },

    /**
     * Dừng hẳn: KHÔNG respawn nữa và chuyển tín hiệu xuống relay để nó chạy
     * shutdown flow của mình. Dùng khi Task Scheduler End task / Ctrl+C / shutdown.
     */
    stop(signal = "SIGTERM") {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child) {
        log(`[supervisor] Chuyển ${signal} xuống relay PID ${child.pid}`);
        try { child.kill(signal); } catch (e) { log(`[supervisor] Kill lỗi: ${e.message}`); }
      }
    },

    isRunning() {
      return child !== null;
    },
    restarts() {
      return restarts;
    },
  };
}

module.exports = { createSupervisor };
