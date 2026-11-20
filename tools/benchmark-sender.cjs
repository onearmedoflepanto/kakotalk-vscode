'use strict';

// Empty text reaches the native INVALID_TEXT check before any window/input operation.
// This benchmark measures preparation and routing only; it never submits a message.
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {performance} = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

function launch(worker) {
  const started = performance.now();
  const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/client-ui.ps1'), ...(worker ? ['-Worker'] : [])],
    {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
  const queue = []; let waiting, ended = false;
  const timer = setTimeout(() => child.kill(), 30000);
  const lines = createInterface({input: child.stdout});
  lines.on('line', line => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); } else queue.push(line); });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const closed = new Promise(resolve => child.on('close', code => { ended = true; clearTimeout(timer); waiting?.(''); resolve(code); }));
  return {child, started, closed, async next() {
    const line = queue.length ? queue.shift() : ended ? '' : await new Promise(resolve => { waiting = resolve; });
    assert.ok(line, 'Sender exited before responding'); return JSON.parse(line.replace(/^\uFEFF/, ''));
  }};
}

async function main() {
  const [mode, roomId, roomTitle, outputName] = process.argv.slice(2);
  assert.ok(['once', 'worker'].includes(mode) && /^[1-9][0-9]{0,19}$/.test(roomId) && roomTitle);
  assert.ok(outputName === undefined || /^[a-z0-9-]+\.json$/.test(outputName));
  const {execFileSync} = require('node:child_process');
  const pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$targets = @(Get-Process -Name KakaoTalk -ErrorAction Stop); if ($targets.Count -ne 1) { throw "Exactly one process required" }; $targets[0].Id'], {windowsHide: true, encoding: 'utf8'}).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  const payload = {pid, roomId, roomTitle, text: ''};
  const samplesMs = []; let startupMs;
  if (mode === 'once') {
    for (let i = 0; i < 3; i++) {
      const session = launch(false);
      session.child.stdin.end(JSON.stringify(payload));
      const code = await session.closed;
      const result = await session.next();
      assert.equal(code, 1); assert.equal(result.code, 'INVALID_TEXT');
      samplesMs.push(performance.now() - session.started);
    }
  } else {
    const session = launch(true);
    try {
      assert.equal((await session.next()).status, 'ready');
      startupMs = performance.now() - session.started;
      for (let i = 1; i <= 5; i++) {
        const started = performance.now();
        session.child.stdin.write(JSON.stringify({...payload, requestId: String(i)}) + '\n');
        const result = await session.next();
        assert.equal(result.requestId, String(i)); assert.equal(result.code, 'INVALID_TEXT');
        samplesMs.push(performance.now() - started);
      }
    } finally { session.child.stdin.end(); }
    assert.equal(await session.closed, 0);
  }
  const round = value => Math.round(value * 100) / 100;
  const result = {observedAt: new Date().toISOString(), mode, sentMessages: 0, inputChanged: false,
    scope: 'PowerShell transport, compilation, client identity and input target resolution; INVALID_TEXT before input access',
    startupMs: startupMs === undefined ? undefined : round(startupMs), samplesMs: samplesMs.map(round),
    medianMs: round([...samplesMs].sort((a, b) => a - b)[Math.floor(samplesMs.length / 2)])};
  const output = path.join(root, '.generated/integration', outputName || (mode === 'once' ? 'send-startup-before.json' : 'send-latency-worker.json'));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
