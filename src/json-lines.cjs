'use strict';
const {TextDecoder} = require('node:util');

class JsonLines {
  constructor(receive, limit = 2 * 1024 * 1024) { this.receive = receive; this.limit = limit; this.pending = Buffer.alloc(0); }
  push(chunk) {
    let at = 0;
    while (at < chunk.length) {
      const newline = chunk.indexOf(10, at), end = newline < 0 ? chunk.length : newline;
      if (this.pending.length + end - at > this.limit) throw new Error('IPC frame exceeds limit.');
      this.pending = Buffer.concat([this.pending, chunk.subarray(at, end)]);
      if (newline < 0) return;
      const line = new TextDecoder('utf-8', {fatal: true}).decode(this.pending).replace(/^\uFEFF/, '');
      this.pending = Buffer.alloc(0);
      if (line.trim()) this.receive(JSON.parse(line));
      at = newline + 1;
    }
  }
  finish() { if (this.pending.length) throw new Error('Incomplete IPC frame.'); }
}
module.exports = {JsonLines};
