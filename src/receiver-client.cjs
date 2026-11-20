'use strict';
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {JsonLines} = require('./json-lines.cjs');
const {validateMessage, validateRoom} = require('./protocol.cjs');

class ReceiverClient extends EventEmitter {
  constructor(root) { super(); this.root = root; this.pending = new Map(); this.sequence = 0; }
  start() {
    if (this.child) return;
    const child = spawn(process.execPath, [path.join(this.root, 'tools/receiver-host.cjs')], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
    });
    this.child = child;
    this.closed = new Promise(resolve => child.once('close', resolve));
    const fail = error => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    };
    const decoder = new JsonLines(value => {
      if (value.version !== 1) throw new Error('Invalid receiver protocol.');
      if (value.id) {
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id); clearTimeout(request.timer);
        if (value.error) request.reject(new Error(value.error)); else request.resolve(value.result);
      } else if (value.event === 'message') this.emit('message', validateMessage(value.value));
      else if (value.event === 'rooms') this.emit('rooms', value.value.map(validateRoom));
      else if (value.event === 'identity') {
        const selfId = value.value?.selfId;
        if (typeof selfId !== 'string' || (selfId !== '' && (!/^[1-9][0-9]{0,19}$/.test(selfId) || BigInt(selfId) > 18446744073709551615n))) throw new Error('Invalid client identity.');
        this.emit('identity', {selfId});
      }
      else if (['notification', 'ready', 'status', 'diagnostic', 'ended'].includes(value.event)) this.emit(value.event, value.value);
    });
    child.stdin.on('error', fail); child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch (error) { fail(error); child.stdin.end(); } });
    child.on('error', fail);
    const heartbeat = setInterval(() => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write('{"version":1,"method":"ping"}\n'); }, 2000);
    child.on('close', code => {
      clearInterval(heartbeat); if (this.child === child) this.child = undefined;
      fail(new Error('수신 프로세스가 종료되었습니다.'));
      if (!this.disposing) { this.emit('status', '수신 프로세스 연결 끊김'); this.emit('ended', {clean: false, code, reason: 'receiver-exit'}); }
    });
  }
  request(method, params) {
    this.start(); const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.child?.stdin.end(); reject(new Error('수신기 응답 시간 초과')); }, 120000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({version: 1, id, method, params}) + '\n');
    });
  }
  discover() { return this.request('discover'); }
  connect(value) { return this.request('connect', value); }
  snapshot() { return this.request('snapshot'); }
  imagePreview(value) { return this.request('imagePreview', value); }
  history(value) { return this.request('history', value); }
  stop(value) { return this.child ? this.request('stop', value) : Promise.resolve({clean: true}); }
  async dispose() {
    this.disposing = true;
    const child = this.child;
    if (child) {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 18000);
      try { await this.closed; } finally { clearTimeout(timeout); }
    }
    this.removeAllListeners();
  }
}
module.exports = {ReceiverClient};
