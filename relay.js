// Load .env sitting NEXT TO this file — Task Scheduler starts us with
// cwd=System32, so the default cwd-relative dotenv lookup would find nothing.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { io } = require('socket.io-client');
const wol = require('wake_on_lan');
const { createFileLogger } = require('./lib/fileLogger');
const { probeHost } = require('./lib/probe');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'UnicornSecretToken2026';
// NO default for BRANCH_ID: registering under the wrong branch silently hijacks
// another branch's probe/WoL. Missing/invalid -> hard-fail below (after logger init).
const BRANCH_ID = parseInt(process.env.BRANCH_ID ?? '', 10);
const WOL_BROADCAST = process.env.WOL_BROADCAST || '255.255.255.255';
const WOL_PORT = parseInt(process.env.WOL_PORT || '9', 10);

// All output goes to logs/relay.log (rotated at 2MB, 3 backups) + echoes to console.
const { log } = createFileLogger({
  filePath: path.join(__dirname, 'logs', 'relay.log'),
  maxSize: 2 * 1024 * 1024,
  maxFiles: 3,
  echo: true,
});

if (!Number.isInteger(BRANCH_ID) || BRANCH_ID <= 0) {
  log('❌ BRANCH_ID is not set (or not a positive integer) in .env — refusing to start.');
  log(`   Set BRANCH_ID=<this branch id> in ${path.join(__dirname, '.env')} then restart.`);
  // Exit non-zero: the supervisor keeps respawning (with backoff) and this error keeps
  // appearing in the log, instead of silently serving the wrong branch.
  process.exit(1);
}

log('=================================');
log('🦄 UNICORN RELAY AGENT STARTED 🦄');
log('=================================');
log(`Server URL: ${SERVER_URL}`);
log(`Branch ID:  ${BRANCH_ID}`);
log(`WOL Config: Broadcast=${WOL_BROADCAST}, Port=${WOL_PORT}`);
log('Connecting to server...');

const socket = io(SERVER_URL, {
  auth: {
    token: AGENT_TOKEN,
  },
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on('connect', () => {
  log('✅ Connected to backend WebSocket server!');

  // Register as Relay Agent for the specific Branch
  socket.emit('relay:register', { branchId: BRANCH_ID }, (response) => {
    if (response?.ok) {
      log(`✅ ${response.message}`);
    } else {
      log(`❌ Relay Registration Failed: ${response?.error}`);
    }
  });
});

socket.on('disconnect', (reason) => {
  log(`⚠️ Disconnected from server: ${reason}`);
});

socket.on('connect_error', (err) => {
  log(`❌ Connection error: ${err.message}`);
});

// Listen for Wake ON LAN (relay:wake) commands from the backend Cloud
socket.on('relay:wake', (payload, callback) => {
  const { targetMac } = payload;

  if (!targetMac) {
    log('❌ Received relay:wake but no targetMac provided.');
    if (callback) callback({ ok: false, error: 'Missing targetMac' });
    return;
  }

  log(`⚡ WAKING UP MAC: ${targetMac}...`);

  wol.wake(targetMac, { address: WOL_BROADCAST, port: WOL_PORT }, (err) => {
    if (err) {
      log(`❌ WOL Error for ${targetMac}: ${err.message}`);
      if (callback) callback({ ok: false, error: err.message });
    } else {
      log(`✅ Magic packet sent to ${targetMac} successfully.`);
      if (callback) callback({ ok: true });
    }
  });
});

// Ping-probe a LAN host for the backend ("is that machine really powered off?").
// Ack exactly once: { ok:true, alive, method:'icmp', detail, arpMac? } or
// { ok:false, error } — ok:false means NO VERDICT, backend falls back to its timer.
socket.on('relay:probe', async (payload, callback) => {
  let replied = false;
  const reply = (ack) => {
    if (replied) return;
    replied = true;
    if (typeof callback === 'function') callback(ack);
  };

  const ip = typeof payload?.ip === 'string' ? payload.ip.trim() : '';
  if (!ip) {
    log('❌ relay:probe missing ip:', payload ?? '(no payload)');
    reply({ ok: false, error: 'no-ip' });
    return;
  }

  log(`🔎 PROBE start ip=${ip} mac=${payload?.mac || '?'} attempts=${payload?.attempts ?? 1} timeoutMsPerPing=${payload?.timeoutMsPerPing ?? 2000}`);
  try {
    const result = await probeHost(payload);
    const ack = { ok: true, alive: result.alive, method: 'icmp', detail: result.detail };
    if (result.alive && result.arpMac) ack.arpMac = result.arpMac;
    log(
      `${result.alive ? '✅ PROBE alive' : '💀 PROBE dead'} ip=${ip}` +
      ` attemptsUsed=${result.attemptsUsed} durationMs=${result.durationMs}` +
      (ack.arpMac ? ` arpMac=${ack.arpMac}` : '') +
      ` detail="${result.detail}"`
    );
    reply(ack);
  } catch (err) {
    const msg = err?.message === 'no-ip' ? 'no-ip' : `spawn-failed: ${err?.message || err}`;
    log(`❌ PROBE error ip=${ip}: ${msg}`);
    reply({ ok: false, error: msg });
  }
});

// Process clean exit
process.on('SIGINT', () => {
  log('🛑 Shutting down Relay Agent...');
  socket.disconnect();
  process.exit();
});
