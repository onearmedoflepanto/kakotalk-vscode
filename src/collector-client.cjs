'use strict';

const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {StringDecoder} = require('node:string_decoder');
const {MessageDecoder, validateMessage} = require('./protocol.cjs');

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const spawnOptions = {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']};

function runProcess(program, args, {timeout = 90000, onChild, maxOutput = 2 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, spawnOptions);
    onChild?.(child);
    const stdout = [], stderr = [];
    let bytes = 0, error;
    const timer = setTimeout(() => { error = new Error('작업 시간 제한을 초과했습니다.'); child.kill(); }, timeout);
    child.stdin.end();
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > maxOutput) { error = new Error('준비 결과의 크기 제한을 초과했습니다.'); child.kill(); }
      else stdout.push(data);
    });
    child.stderr.on('data', data => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 16000) stderr.push(data); });
    child.on('error', value => { error = value; });
    child.on('close', code => {
      clearTimeout(timer);
      if (error || code !== 0) reject(error || new Error(Buffer.concat(stderr).toString('utf8').trim().slice(0, 600) || `작업 종료 코드: ${code}`));
      else resolve(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim());
    });
  });
}

class CollectorClient extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.generation = 0;
    this.sequence = 0;
  }
  async prepare(args, onChild) {
    const output = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(this.root, 'tools', 'collector', 'prepare.ps1'), ...args], {onChild});
    return JSON.parse(output);
  }
  async discover() {
    const result = await this.prepare(['-ListRooms']);
    if (!Array.isArray(result.rooms)) throw new Error('채팅방 목록 형식이 올바르지 않습니다.');
    return result.rooms.filter(room => /^[1-9][0-9]{0,19}$/.test(room.id) && typeof room.title === 'string' && room.title.length <= 256);
  }
  async connect({workerPath, roomId, duration = 3600, includeExisting = true}) {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId)) throw new Error('채팅방 ID가 올바르지 않습니다.');
    if (!Number.isInteger(duration) || duration < 1 || duration > 3600) throw new Error('관찰 시간은 1~3600초입니다.');
    await this.stop();
    const generation = ++this.generation;
    this.emit('status', '채팅방 준비 중');
    let metadata;
    try { metadata = await this.prepare(['-RoomId', roomId, '-Stdout'], child => { this.preparing = child; }); }
    finally { this.preparing = undefined; }
    if (generation !== this.generation) return false;
    return this.launch({workerPath, metadata, duration, includeExisting}, generation);
  }
  launch({workerPath, metadata, duration, includeExisting = false, program, args}, generation = ++this.generation) {
    this.emit('status', '연결 중');
    const child = spawn(program || workerPath, args || ['collect', '--metadata-stdin', '--initial-snapshot', '--duration', String(duration), ...(includeExisting ? ['--include-existing'] : [])], spawnOptions);
    this.child = child;
    this.lastCleanup = undefined;
    let ready = false, failure = '', stopped, stderrPending = '';
    const stderrDecoder = new StringDecoder('utf8');
    const active = () => generation === this.generation;
    const decoder = new MessageDecoder(event => {
      if (event.source !== 'client' || event.roomId !== metadata.roomId) throw new Error('Unexpected collector room.');
      if (active()) this.emit('message', event);
    });
    const control = command => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(JSON.stringify({command}) + '\n'); };
    this.historyControl = value => {
      if (!active() || !ready || !child.stdin.writable || child.stdin.destroyed) throw new Error('수신기가 연결되지 않았습니다.');
      child.stdin.write(JSON.stringify(value) + '\n');
    };
    let resolveReady, rejectReady;
    const result = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const heartbeat = setInterval(() => control('ping'), 2000);
    let forceStop;
    const requestStop = () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      forceStop ||= setTimeout(() => child.kill(), 14000);
    };
    const startup = setTimeout(() => { failure = '수집기 연결 시간 초과'; requestStop(); }, 20000);
    let resolveFinished;
    const finish = new Promise(resolve => { resolveFinished = resolve; });
    this.finished = finish;
    child.stdin.on('error', () => {});
    child.on('error', error => { failure = `수집기 실행 실패 (${error.code || 'UNKNOWN'})`; });
    child.stdout.on('data', chunk => {
      try { decoder.push(chunk); }
      catch { failure = '수집 메시지 형식 오류'; requestStop(); }
    });
    child.stderr.on('data', chunk => {
      stderrPending += stderrDecoder.write(chunk);
      if (stderrPending.length > 2 * 1024 * 1024) { failure = '수집기 상태 크기 초과'; requestStop(); stderrPending = ''; return; }
      let newline;
      while ((newline = stderrPending.indexOf('\n')) >= 0) {
        const line = stderrPending.slice(0, newline).trim();
        stderrPending = stderrPending.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.status === 'history') {
            const request = this.historyRequest;
            if (active() && request?.id === value.requestId) {
              this.historyRequest = undefined; clearTimeout(request.timer);
              if (value.error) request.reject(new Error(value.error));
              else {
                try {
                  if (!Array.isArray(value.messages) || value.messages.length > 100) throw new Error('Invalid history page.');
                  const events = value.messages.map(validateMessage);
                  if (events.some(event => event.source !== 'client' || event.roomId !== metadata.roomId || BigInt(event.id) >= BigInt(request.before))) throw new Error('Unexpected history room or cursor.');
                  request.resolve(events);
                } catch (error) { request.reject(error); }
              }
            }
            continue;
          }
          if (value.status === 'ready') {
            ready = true; clearTimeout(startup);
            if (active()) { this.emit('status', '로컬 수신 연결됨'); this.emit('ready', value); }
            resolveReady(true);
          } else if (value.status === 'error') failure ||= value.message || '수집기 오류';
          if (value.cleanup) { stopped = value; this.lastCleanup = value.cleanup; }
          if (active()) this.emit('diagnostic', value);
        } catch { failure = '수집기 상태를 해석하지 못했습니다.'; requestStop(); }
      }
    });
    child.on('close', code => {
      clearInterval(heartbeat); clearTimeout(startup); clearTimeout(forceStop);
      try { decoder.finish(); } catch { failure ||= '메시지 수신 중 수집기가 종료되었습니다.'; }
      const clean = stopped?.cleanup && ['hookRestored', 'scriptUnloaded', 'sessionDetached'].every(key => stopped.cleanup[key] === true);
      if (ready && !clean) failure ||= '수집기 종료 후 훅 해제를 확인하지 못했습니다.';
      if (code !== 0) failure ||= `수집기 종료 코드: ${code}`;
      if (this.child === child) this.child = undefined;
      if (this.historyRequest?.generation === generation) this.cancelHistory();
      if (active()) {
        this.emit('status', failure || (stopped?.reason === 'duration-ended' ? '관찰 시간 종료' : '연결 끊김'));
        this.emit('ended', {code, clean: Boolean(clean), reason: stopped?.reason, error: failure});
      }
      if (!ready) rejectReady(new Error(failure || '수집기가 연결 전에 종료되었습니다.'));
      resolveFinished({code, clean: Boolean(clean), reason: stopped?.reason, error: failure});
    });
    child.stdin.write(JSON.stringify(metadata) + '\n');
    return result;
  }
  cancelHistory() {
    const request = this.historyRequest;
    if (request) { this.historyRequest = undefined; clearTimeout(request.timer); request.reject(new Error('과거 메시지 조회가 종료되었습니다.')); }
  }
  history(params) {
    if (this.historyRequest) return Promise.reject(new Error('과거 메시지를 불러오는 중입니다.'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancelHistory(), 15000);
      this.historyRequest = {id, before: params.before, generation: this.generation, resolve, reject, timer};
      try {
        if (!this.historyControl) throw new Error('수신기가 연결되지 않았습니다.');
        this.historyControl({command: 'history', id, params});
      } catch (error) { clearTimeout(timer); this.historyRequest = undefined; reject(error); }
    });
  }
  async stop() {
    this.cancelHistory(); this.historyControl = undefined;
    this.generation++;
    if (this.preparing) { this.preparing.kill(); this.preparing = undefined; }
    const child = this.child;
    if (!child) return;
    child.stdin.end(JSON.stringify({command: 'stop'}) + '\n');
    const timeout = setTimeout(() => child.kill(), 14000);
    try { return await this.finished; }
    finally { clearTimeout(timeout); }
  }
  async dispose() { await this.stop(); this.removeAllListeners(); }
}

module.exports = {CollectorClient, runProcess};
