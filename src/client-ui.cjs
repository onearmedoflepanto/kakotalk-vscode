'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {ReplyClient} = require('./reply-client.cjs');

const sendErrors = Object.freeze({
  DRAFT_EXISTS: 'PC카톡 입력창에 작성 중인 내용이 있습니다. 카톡에서 보관하거나 지운 뒤 다시 보내세요. 이번 요청은 전송하지 않았습니다.',
  ROOM_CHANGED: '채팅방이 변경되었거나 같은 이름의 방이 있습니다. 대상 방을 다시 연결하세요.',
  WINDOW_UNAVAILABLE: '선택한 PC카톡 채팅방 창을 하나만 열고 다시 보내세요.',
  INPUT_UNAVAILABLE: 'PC카톡 입력창을 찾지 못했습니다. 선택한 채팅방을 열어 주세요.',
  INVALID_TEXT: '메시지는 1~2,000자로 입력하세요.',
  MODIFIER_HELD: 'Ctrl·Shift·Alt 키를 놓은 뒤 다시 보내세요. 이번 요청은 전송하지 않았습니다.',
  TEXT_MISMATCH: 'PC카톡에 입력된 내용이 요청과 달라 전송을 중단했습니다. 카톡 입력창을 확인하세요.',
  INPUT_UNRESPONSIVE: 'PC카톡 입력창의 응답을 확인하지 못했습니다. 카톡에서 전송 여부를 확인하세요.',
  SUBMISSION_UNCONFIRMED: 'PC카톡의 전송 완료를 확인하지 못했습니다. 카톡에서 확인한 뒤 다시 보내세요. 자동 재전송하지 않습니다.',
  TIMEOUT: '전송 확인 시간이 초과됐습니다. PC카톡에서 전송 여부를 확인하세요.',
  START_FAILED: 'PC카톡 전송 도구를 실행하지 못했습니다. 연결 로그를 확인하세요.',
  BUSY: '이전 메시지의 전송 확인이 끝난 뒤 보내세요.',
  REPLY_CONFLICT: 'PC카톡에서 답장 또는 수정 중인 메시지가 있습니다. 카톡에서 해당 작성을 마친 뒤 다시 보내세요.',
  REPLY_UNAVAILABLE: '답장할 원문을 PC카톡에서 불러오지 못했습니다. 해당 대화에서 원문을 확인한 뒤 다시 보내세요.',
  REPLY_MISMATCH: '카톡에 선택된 답장 원문이 요청과 달라 전송을 중단했습니다.',
  REPLY_PREPARE_FAILED: '카톡의 답장 원문 선택을 확인하지 못했습니다. 메시지는 전송하지 않았습니다.',
  INVALID_RESPONSE: '전송 도구의 응답을 읽지 못했습니다. PC카톡에서 전송 여부를 확인하세요.',
  CLIENT_ERROR: 'PC카톡 전송 준비에 실패했습니다. 클라이언트 실행 상태와 연결된 방을 확인하세요.'
});
function sendError(code) {
  const key = Object.hasOwn(sendErrors, code) ? code : 'CLIENT_ERROR';
  return Object.assign(new Error(sendErrors[key]), {code: key});
}
function parseSendResult(output, exitCode) {
  let result;
  try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); }
  catch { throw sendError('INVALID_RESPONSE'); }
  if (exitCode !== 0 || result?.status !== 'submitted' || result.inputCleared !== true) throw sendError(result?.code);
  return result;
}
function preparedTarget(result, roomId) {
  if (result?.status === 'error') throw sendError(result.code);
  const target = result?.inputTarget;
  if (result?.status !== 'prepared' || result.roomId !== roomId || !target ||
      !['dialog','window','editor'].every(k => typeof target[k] === 'string' && /^0x[0-9a-f]{1,16}$/i.test(target[k]) && BigInt(target[k]) > 0n && BigInt(target[k]) <= 0x7fffffffffffn) ||
      typeof target.processStartFileTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(target.processStartFileTime) || BigInt(target.processStartFileTime) > 18446744073709551615n) throw sendError('INVALID_RESPONSE');
  return {dialog:target.dialog, window:target.window, editor:target.editor, processStartFileTime:target.processStartFileTime};
}

function validateSend(value) {
  if (!value || !Number.isInteger(value.pid) || value.pid < 1 || !/^[1-9][0-9]{0,19}$/.test(value.roomId)) throw new Error('연결된 채팅방을 확인하세요.');
  if (typeof value.roomTitle !== 'string' || !value.roomTitle.trim() || value.roomTitle.length > 256) throw new Error('채팅방 이름을 확인하세요.');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000 || value.text.includes('\0')) throw new Error('메시지는 1~2,000자로 입력하세요.');
  const result = {pid: value.pid, roomId: value.roomId, roomTitle: value.roomTitle, text: value.text};
  if (value.replyTo !== undefined) {
    if (!value.replyTo || !['id','senderId'].every(k => typeof value.replyTo[k] === 'string' && /^[1-9][0-9]{0,19}$/.test(value.replyTo[k]) && BigInt(value.replyTo[k]) <= 18446744073709551615n)) throw new Error('답장할 원문을 다시 선택하세요.');
    if (value.text.length > 500) throw new Error('답장은 1~500자로 입력하세요.');
    result.replyTo = {id:value.replyTo.id, senderId:value.replyTo.senderId};
  }
  return result;
}

class ClientSender {
  constructor(root, {spawnProcess = spawn, startupTimeoutMs = 15000, requestTimeoutMs = 75000, replySelector = new ReplyClient(root)} = {}) {
    this.root = root;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sequence = 0;
    this.inFlight = false;
    this.replySelector = replySelector;
  }
  start() {
    if (this.session) { const session = this.session; return session.ready.then(() => session); }
    if (process.platform !== 'win32') return Promise.reject(new Error('Windows에서 사용할 수 있습니다.'));
    const session = {buffer: '', state: 'starting'};
    session.ready = new Promise((resolve, reject) => { session.resolveReady = resolve; session.rejectReady = reject; });
    session.closed = new Promise(resolve => { session.resolveClosed = resolve; });
    this.session = session;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const child = this.spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'tools', 'client-ui.ps1'), '-Worker'], {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
      session.child = child;
      session.timer = setTimeout(() => this.fail(session, sendError('START_FAILED')), this.startupTimeoutMs);
      child.stdin.on('error', () => this.fail(session, sendError('SUBMISSION_UNCONFIRMED')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => this.read(session, data));
      child.stderr.on('data', () => {});
      child.on('error', () => this.fail(session, sendError('START_FAILED')));
      child.on('close', () => {
        this.fail(session, sendError(session.pending ? 'SUBMISSION_UNCONFIRMED' : 'START_FAILED'));
        session.resolveClosed();
      });
    } catch { this.fail(session, sendError('START_FAILED')); session.resolveClosed(); }
    return session.ready.then(() => session);
  }
  async warm() { await this.start(); }
  fail(session, error) {
    if (session.state === 'closed') return;
    session.state = 'closed';
    clearTimeout(session.timer);
    session.rejectReady(error);
    if (session.pending) { clearTimeout(session.pending.timer); session.pending.reject(error); session.pending = undefined; }
    session.buffer = '';
    if (this.session === session) this.session = undefined;
    session.child?.kill();
  }
  read(session, data) {
    if (session.state === 'closed') return;
    session.buffer += data;
    if (session.buffer.length > 10000) { this.fail(session, sendError('INVALID_RESPONSE')); return; }
    for (let index; (index = session.buffer.indexOf('\n')) >= 0;) {
      const line = session.buffer.slice(0, index).replace(/^\uFEFF/, '').trim();
      session.buffer = session.buffer.slice(index + 1);
      let result;
      try { result = JSON.parse(line); }
      catch { this.fail(session, sendError('INVALID_RESPONSE')); return; }
      if (session.state === 'starting' && result?.status === 'ready' && result.protocolVersion === 1) {
        clearTimeout(session.timer); session.state = 'ready'; session.resolveReady(); continue;
      }
      const pending = session.pending;
      if (session.state !== 'ready' || !pending || result?.requestId !== pending.id || !['submitted', 'prepared', 'error'].includes(result.status)) {
        this.fail(session, sendError('INVALID_RESPONSE')); return;
      }
      clearTimeout(pending.timer); session.pending = undefined;
      try { pending.resolve(pending.operation === 'prepare' ? preparedTarget(result, pending.roomId) : parseSendResult(line, 0)); }
      catch (error) { pending.reject(error); }
    }
  }
  request(session, payload) {
    if (session.state !== 'ready' || session !== this.session) return Promise.reject(sendError('START_FAILED'));
    if (session.pending) return Promise.reject(sendError('BUSY'));
    return new Promise((resolve, reject) => {
      const id = String(++this.sequence);
      const timer = setTimeout(() => this.fail(session, sendError('TIMEOUT')), this.requestTimeoutMs);
      session.pending = {id, resolve, reject, timer, operation:payload.operation, roomId:payload.roomId};
      // One request at a time. Text and pointers remain in the private child stream.
      try { session.child.stdin.write(JSON.stringify({...payload, requestId: id}) + '\n'); }
      catch { this.fail(session, sendError('SUBMISSION_UNCONFIRMED')); }
    });
  }
  async send(request, {workerPath} = {}) {
    const payload = validateSend(request);
    if (this.inFlight) throw sendError('BUSY');
    this.inFlight = true;
    try {
      const session = await this.start();
      if (!session || session.state !== 'ready' || session !== this.session) throw sendError('START_FAILED');
      if (payload.replyTo) {
        const inputTarget = await this.request(session, {operation:'prepare', pid:payload.pid, roomId:payload.roomId, roomTitle:payload.roomTitle});
        try { await this.replySelector.prepare({...payload, text:undefined, inputTarget}, workerPath); }
        catch (error) { throw sendError(error.code || 'REPLY_PREPARE_FAILED'); }
        if (session.state !== 'ready' || session !== this.session) throw sendError('REPLY_PREPARE_FAILED');
      }
      return await this.request(session, payload);
    } finally { this.inFlight = false; }
  }
  async stop() {
    const session = this.session;
    if (session) this.fail(session, sendError('SUBMISSION_UNCONFIRMED'));
    await this.replySelector.stop();
    if (session) await session.closed;
  }
}

module.exports = {validateSend, ClientSender, parseSendResult};
