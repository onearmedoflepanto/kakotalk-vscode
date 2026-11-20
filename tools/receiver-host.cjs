'use strict';
const path = require('node:path');
const {ReceiverService} = require('../src/receiver-service.cjs');
const {JsonLines} = require('../src/json-lines.cjs');

const service = new ReceiverService(path.resolve(__dirname, '..'));
let ending = false, lastPing = Date.now(), busy = 0;
function write(value) {
  if (ending || process.stdout.destroyed) return;
  if (process.stdout.writableLength > 2 * 1024 * 1024) { void close(); return; }
  process.stdout.write(JSON.stringify({version: 1, ...value}) + '\n');
}
for (const event of ['message', 'rooms', 'identity', 'notification', 'ready', 'status', 'diagnostic', 'ended']) service.on(event, value => write({event, value}));
async function close() {
  if (ending) return;
  ending = true; clearInterval(heartbeat); process.stdin.pause();
  await service.dispose(); process.exitCode = 0; process.stdin.destroy();
}
const heartbeat = setInterval(() => { if (Date.now() - lastPing > 10000) void close(); }, 2000);
const decoder = new JsonLines(value => {
  if (value.version !== 1 || typeof value.method !== 'string') throw new Error('Invalid receiver command.');
  if (value.method === 'ping') { lastPing = Date.now(); return; }
  if (typeof value.id !== 'string' || value.id.length > 80) throw new Error('Missing request ID.');
  if (busy && value.method !== 'stop') { write({id: value.id, error: '수신기 작업이 진행 중입니다.'}); return; }
   const actions = {discover: () => service.discover(), connect: () => service.connect(value.params || {}), history: () => service.history(value.params), imagePreview: () => service.imagePreview(value.params), stop: () => service.stop(value.params), snapshot: () => ({rooms: service.rooms, messages: service.store.snapshot(), selfId: service.selfId})};
  if (!Object.hasOwn(actions, value.method)) throw new Error('Unsupported receiver command.');
  busy++;
  void Promise.resolve().then(actions[value.method]).then(result => write({id: value.id, result: result ?? null}), error => write({id: value.id, error: error.message})).finally(() => { busy--; });
});
process.stdin.on('data', chunk => { try { decoder.push(chunk); } catch (_) { void close(); } });
process.stdin.on('end', () => { void close(); });
process.stdin.on('error', () => { void close(); });
process.stdout.on('error', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
