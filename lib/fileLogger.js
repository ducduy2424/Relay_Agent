// Logger ghi vào MỘT file riêng, tự xoay file khi vượt kích thước.
// Tách khỏi agent.js để các luồng log tần suất cao (vd: heartbeat mỗi ~10s) có
// file riêng, KHÔNG làm ngập agent.log → log quan trọng (shutdown/lock/error)
// không bị xoay mất oan.
//
// Dùng lại đúng cơ chế xoay file của agent.js: file.log → file.log.1 → ... → file.log.N.

const fs = require("fs");
const path = require("path");

/**
 * Tạo logger ghi vào một file riêng, tự xoay khi vượt maxSize.
 * @param {Object} opts
 * @param {string} opts.filePath - đường dẫn file log (vd .../logs/heartbeat.log).
 * @param {number} [opts.maxSize=5MB] - ngưỡng xoay file (byte).
 * @param {number} [opts.maxFiles=3] - số file backup giữ lại (.1 → .N).
 * @param {boolean} [opts.echo=true] - có in ra console không (giữ live-tail như cũ).
 * @returns {{ log: (...args:any[]) => void }}
 */
function createFileLogger({ filePath, maxSize = 5 * 1024 * 1024, maxFiles = 3, echo = true }) {
  if (!filePath) throw new Error("createFileLogger: cần filePath");

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(filePath)) return;
      if (fs.statSync(filePath).size < maxSize) return;

      const oldest = `${filePath}.${maxFiles}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = `${filePath}.${i}`;
        const dst = `${filePath}.${i + 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      fs.renameSync(filePath, `${filePath}.1`);
    } catch (e) {
      // Rotate lỗi thì vẫn cố ghi tiếp bình thường.
      console.error(`[file-logger] rotate error: ${e.message}`);
    }
  }

  function log(...args) {
    const timestamp = new Date().toISOString();
    const message = args
      .map(arg => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
      .join(" ");
    const logLine = `[${timestamp}] ${message}`;

    if (echo) console.log(logLine);

    rotateIfNeeded();
    try {
      fs.appendFileSync(filePath, logLine + "\n");
    } catch (e) {
      console.error(`[file-logger] write error: ${e.message}`);
    }
  }

  return { log };
}

module.exports = { createFileLogger };
