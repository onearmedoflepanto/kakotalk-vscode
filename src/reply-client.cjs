'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {JsonLines} = require('./json-lines.cjs');

// Selects a native reply target only. The normal sender owns text insertion and Enter.
class ReplyClient {
  constructor(root, {spawnProcess = spawn, timeoutMs = 25000} = {}) { Object.assign(this,{root,spawnProcess,timeoutMs}); }
  prepare(request, workerPath) {
    if (this.child || typeof workerPath !== 'string' || !path.isAbsolute(workerPath)) return Promise.reject(Object.assign(new Error('Reply selector unavailable.'),{code:'REPLY_PREPARE_FAILED'}));
    return new Promise((resolve,reject) => {
      let result, failure, finished = false, exited = false, diagnostic = '';
      const child = this.spawnProcess(workerPath,['reply'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      this.child = child;
      this.closed = new Promise(done => { this.closeDone = done; });
      const fail = code => { failure = Object.assign(new Error(code),{code}); child.stdin.end(); };
      const closeReads = () => { if(result&&exited){child.stdout.destroy();child.stderr.destroy();} };
      const parser = new JsonLines(value => { if (result) return fail('REPLY_PREPARE_FAILED'); result = value; child.stdin.end(); queueMicrotask(closeReads); }, 16384);
      const timer = setTimeout(() => { fail('REPLY_PREPARE_FAILED'); child.kill(); },this.timeoutMs);
      child.stdout.on('data',chunk => { try { parser.push(chunk); } catch (_) { fail('REPLY_PREPARE_FAILED'); } });
      child.stderr.on('data',chunk=>{if(diagnostic.length<6000)diagnostic+=chunk.toString('utf8');});
      child.stdin.on('error',()=>fail('REPLY_PREPARE_FAILED'));
      child.on('error',()=>fail('REPLY_PREPARE_FAILED'));
      child.on('exit',()=>{
        exited = true;
        // Frida helper descendants can retain inherited pipe handles after Python exits.
        // A complete cleanup frame plus the worker's exit is sufficient to close our reads.
        queueMicrotask(closeReads);
      });
      child.on('close',code => {
        if (finished) return; finished = true; clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        this.closeDone();
        try { parser.finish(); } catch (_) { failure ||= Object.assign(new Error('Invalid reply response.'),{code:'REPLY_PREPARE_FAILED'}); }
        if (failure || code !== 0 || result?.status !== 'prepared' || result?.clean !== true || result.roomId !== request.roomId || result.replyId !== request.replyTo.id) {
          reject(Object.assign(failure || new Error('Native reply selection failed.'),{code:failure?.code || result?.code || 'REPLY_PREPARE_FAILED',diagnostic}));
        } else resolve(result);
      });
      child.stdin.write(JSON.stringify({pid:request.pid,roomId:request.roomId,roomTitle:request.roomTitle,replyTo:request.replyTo,...(request.inputTarget ? {inputTarget:request.inputTarget} : {})})+'\n');
    });
  }
  async stop() { if (this.child) { this.child.stdin.end(); await this.closed; } }
}
module.exports = {ReplyClient};
