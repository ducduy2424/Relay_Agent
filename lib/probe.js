// ICMP ping probe for the relay:probe command. All tuning parameters arrive in
// the payload from the server (no new env keys on the relay side).
//
// Verdict semantics (per plan — do not "simplify"):
//   alive  = ping.exe exit code 0 AND stdout contains "TTL=". Exit code alone is
//            NOT enough: ping.exe exits 0 on "Destination host unreachable"
//            (that reply comes from the gateway, not the target). Only a real
//            echo-reply prints "TTL=", and that token survives localized Windows.
//   arpMac = read from the ARP cache ONLY after a successful ping (the ping just
//            refreshed the cache). ARP is never used as evidence of death.
//   A rejected promise here means NO VERDICT (relay answers ok:false).

const { execFile } = require("child_process");
const path = require("path");

// Absolute paths — PATH is not guaranteed under SYSTEM (Task Scheduler).
const SYSTEM32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const PING_EXE = path.join(SYSTEM32, "ping.exe");
const ARP_EXE = path.join(SYSTEM32, "arp.exe");

const MAC_RE = /(?:[0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Detail line for logging: prefer the echo-reply line (has TTL=), else the last
// non-empty stdout line, else the error message.
function extractDetail(stdout, err) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const ttlLine = lines.find((line) => /TTL=/i.test(line));
  return ttlLine || lines[lines.length - 1] || (err ? String(err.message || err) : "");
}

/**
 * One ICMP echo. Resolves { alive, detail }. A non-replying host is a NORMAL
 * outcome (alive:false); the promise only rejects when we cannot trust the run:
 * spawn failure (err.code is a string like ENOENT) or the kill-guard fired.
 */
function pingOnce(ip, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      PING_EXE,
      ["-n", "1", "-w", String(timeoutMs), "-4", ip],
      // Kill-guard: never let a wedged ping.exe hang the probe past its own -w.
      { windowsHide: true, timeout: timeoutMs + 3000 },
      (err, stdout) => {
        if (err && typeof err.code === "string") {
          return reject(new Error(`ping spawn error: ${err.code} ${err.message}`));
        }
        if (err && err.killed) {
          return reject(new Error(`ping killed by guard after ${timeoutMs + 3000}ms`));
        }
        // err with numeric code = ping ran but got no echo-reply → dead attempt.
        resolve({
          alive: !err && /TTL=/i.test(String(stdout || "")),
          detail: extractDetail(stdout, err),
        });
      }
    );
  });
}

/**
 * Read the MAC for ip from the ARP cache. Call ONLY after a successful ping.
 * Resolves a normalized MAC ("aa:bb:cc:dd:ee:ff") or null — never rejects
 * (ARP miss/parse fail just means "alive but MAC unverified").
 */
function getArpMac(ip) {
  return new Promise((resolve) => {
    execFile(ARP_EXE, ["-a", ip], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] !== ip) continue; // skip "Interface: x.x.x.x ---" header & other rows
        const m = line.match(MAC_RE);
        if (m) return resolve(m[0].toLowerCase().replace(/-/g, ":"));
      }
      resolve(null);
    });
  });
}

/**
 * Full probe: loop pings, short-circuit on the first real echo-reply.
 * @param {{ip:string, attempts?:number, intervalMs?:number, timeoutMsPerPing?:number}} payload
 * @returns {Promise<{alive:boolean, arpMac?:string, attemptsUsed:number, durationMs:number, detail:string}>}
 */
async function probeHost(payload = {}) {
  const ip = typeof payload.ip === "string" ? payload.ip.trim() : "";
  if (!ip) throw new Error("no-ip"); // relay.js checks first; this is a backstop

  const attempts = clamp(payload.attempts, 1, 10, 1);
  const intervalMs = clamp(payload.intervalMs, 0, 10000, 0);
  const timeoutMsPerPing = clamp(payload.timeoutMsPerPing, 200, 5000, 2000);

  const startedAt = Date.now();
  let detail = "";
  let attemptsUsed = 0;

  for (let i = 0; i < attempts; i++) {
    if (i > 0 && intervalMs > 0) await sleep(intervalMs);
    attemptsUsed = i + 1;
    const ping = await pingOnce(ip, timeoutMsPerPing);
    detail = ping.detail;
    if (ping.alive) {
      // One real echo-reply is enough. Fetch arpMac now so the backend can
      // verify WHO replied (guards against DHCP handing the IP to another box).
      const arpMac = await getArpMac(ip);
      const result = { alive: true, attemptsUsed, durationMs: Date.now() - startedAt, detail };
      if (arpMac) result.arpMac = arpMac;
      return result;
    }
  }
  return { alive: false, attemptsUsed, durationMs: Date.now() - startedAt, detail };
}

module.exports = { pingOnce, getArpMac, probeHost };
