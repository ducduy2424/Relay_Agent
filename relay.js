require('dotenv').config();
const { io } = require('socket.io-client');
const wol = require('wake_on_lan');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'UnicornSecretToken2026';
const BRANCH_ID = parseInt(process.env.BRANCH_ID || '1', 10);
const WOL_BROADCAST = process.env.WOL_BROADCAST || '255.255.255.255';
const WOL_PORT = parseInt(process.env.WOL_PORT || '9', 10);

console.log('=================================');
console.log('🦄 UNICORN RELAY AGENT STARTED 🦄');
console.log('=================================');
console.log(`Server URL: ${SERVER_URL}`);
console.log(`Branch ID:  ${BRANCH_ID}`);
console.log(`WOL Config: Broadcast=${WOL_BROADCAST}, Port=${WOL_PORT}`);
console.log('Connecting to server...\n');

const socket = io(SERVER_URL, {
  auth: {
    token: AGENT_TOKEN,
  },
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on('connect', () => {
  console.log('✅ Connected to backend WebSocket server!');
  
  // Register as Relay Agent for the specific Branch
  socket.emit('relay:register', { branchId: BRANCH_ID }, (response) => {
    if (response?.ok) {
      console.log(`✅ ${response.message}`);
    } else {
      console.error(`❌ Relay Registration Failed: ${response?.error}`);
    }
  });
});

socket.on('disconnect', (reason) => {
  console.log(`⚠️ Disconnected from server: ${reason}`);
});

socket.on('connect_error', (err) => {
  console.error(`❌ Connection error: ${err.message}`);
});

// Listen for Wake ON LAN (relay:wake) commands from the backend Cloud
socket.on('relay:wake', (payload, callback) => {
  const { targetMac } = payload;
  
  if (!targetMac) {
    console.error('❌ Received relay:wake but no targetMac provided.');
    if (callback) callback({ ok: false, error: 'Missing targetMac' });
    return;
  }

  console.log(`⚡ WAKING UP MAC: ${targetMac}...`);

  wol.wake(targetMac, { address: WOL_BROADCAST, port: WOL_PORT }, (err) => {
    if (err) {
      console.error(`❌ WOL Error for ${targetMac}: ${err.message}`);
      if (callback) callback({ ok: false, error: err.message });
    } else {
      console.log(`✅ Magic packet sent to ${targetMac} successfully.`);
      if (callback) callback({ ok: true });
    }
  });
});

// Process clean exit
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Relay Agent...');
  socket.disconnect();
  process.exit();
});
