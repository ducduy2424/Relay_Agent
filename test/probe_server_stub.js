// Dev-only backend stub: verifies the relay:probe round-trip under parallel load
// (plan Phase A5/A6) without a real backend. Requires devDependency socket.io.
//
// Usage:
//   node test/probe_server_stub.js [ip=127.0.0.1] [count=10] [port=35001]
// Then point the relay at it and start it:
//   .env: SERVER_URL=http://127.0.0.1:35001  →  node relay.js
//
// The stub accepts relay:register, then fires `count` parallel probes at `ip`
// plus a bad-payload round ({}, ip:'', attempts:9999) and prints every ack.

const { Server } = require('socket.io');

const ip = process.argv[2] || '127.0.0.1';
const count = parseInt(process.argv[3] || '10', 10);
const port = parseInt(process.argv[4] || '35001', 10);

const io = new Server(port, { cors: { origin: '*' } });
console.log(`[stub] listening on :${port} — waiting for relay to connect...`);

io.on('connection', (socket) => {
  console.log(`[stub] relay connected: ${socket.id} (handshake token: ${socket.handshake?.auth?.token ? 'present' : 'MISSING'})`);

  socket.on('relay:register', async (payload, cb) => {
    console.log('[stub] relay:register', JSON.stringify(payload));
    if (typeof cb === 'function') cb({ ok: true, message: `Registered relay for branch ${payload?.branchId} (stub)` });

    await fireParallelProbes(socket);
    await fireBadPayloads(socket);
    console.log('[stub] done — Ctrl+C to exit (relay stays connected for manual testing).');
  });
});

function probe(socket, payload, tag) {
  return new Promise((resolve) => {
    socket.timeout(30000).emit('relay:probe', payload, (err, ack) => {
      if (err) {
        console.log(`[stub] ${tag} ACK TIMEOUT (${err.message})`);
        return resolve({ tag, timeout: true });
      }
      console.log(`[stub] ${tag} ack:`, JSON.stringify(ack));
      resolve({ tag, ack });
    });
  });
}

async function fireParallelProbes(socket) {
  console.log(`[stub] firing ${count} parallel probes at ${ip}...`);
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      probe(socket, { mac: `stub-${i}`, ip, attempts: 1, intervalMs: 0, timeoutMsPerPing: 2000 }, `probe#${i}`)
    )
  );
  const acked = results.filter((r) => r.ack).length;
  const alive = results.filter((r) => r.ack?.ok && r.ack.alive).length;
  console.log(`[stub] parallel round done in ${Date.now() - startedAt}ms — acks ${acked}/${count}, alive ${alive}/${count}`);
}

async function fireBadPayloads(socket) {
  console.log('[stub] firing bad payloads (expect no-ip / clamped attempts)...');
  await probe(socket, {}, 'bad:empty-object');
  await probe(socket, { ip: '' }, 'bad:empty-ip');
  // attempts:9999 must clamp to 10 — with timeoutMsPerPing clamped to 200 this
  // stays well under the ack timeout even against a dead ip.
  await probe(socket, { mac: 'stub-clamp', ip, attempts: 9999, intervalMs: 0, timeoutMsPerPing: 1 }, 'bad:attempts-9999');
}
