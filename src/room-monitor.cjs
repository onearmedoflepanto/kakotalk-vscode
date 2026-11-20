'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const {JsonLines} = require('./json-lines.cjs');

class RoomMonitor {
  constructor(root) { this.root = root; this.sequence = 0; this.pending = new Map(); }
  start() {
    if (this.child) return;
    const program = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(program, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'tools/room-state.ps1')], {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    this.closed = new Promise(resolve => child.once('close', resolve));
    const fail = error => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
    };
    const decoder = new JsonLines(value => {
      const request = this.pending.get(value.id);
      if (!request) throw new Error('Unexpected room response.');
      this.pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new Error(value.error)); else request.resolve(value.result);
    });
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch (error) { fail(error); child.kill(); } });
    child.on('error', fail);
    child.on('close', () => { if (this.child === child) this.child = undefined; fail(new Error('채팅방 감시 프로세스가 종료되었습니다.')); });
  }
  snapshot(refresh = false) {
    return this.request({command: 'snapshot', refresh});
  }
  imagePreview(value) { return this.request({...value, command: 'image-preview'}); }
  history(value) { return this.request({...value, command: 'history'}); }
  request(value) {
    this.start();
    if (this.pending.size >= 4) return Promise.reject(new Error('Room worker is busy.'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.child?.kill(); reject(new Error('채팅방 조회 시간 초과')); }, 90000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({...value, id}) + '\n');
    });
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
module.exports = {RoomMonitor};
