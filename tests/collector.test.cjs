'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateMessage } = require('../src/protocol.cjs');
const source = fs.readFileSync(path.join(__dirname, '../tools/collector/agent.js'), 'utf8');

function fixture(options = {}) {
  const base = 0x140000000n;
  const target = base + 0x13fb9d0n;
  const original = Buffer.from('48895c2418555657415441554156415748', 'hex');
  const regions = new Map();
  const add = (address, size) => { const data = Buffer.alloc(size); regions.set(BigInt(address), data); return data; };
  const code = add(target, 32); original.copy(code);
  const logAddress = 0x100000n, bodyHeader = 0x200000n, userAddress = 0x300000n;
  const log = add(logAddress, 0x100), body = add(bodyHeader, 16384), user = add(userAddress, 0x100);
  log.writeBigUInt64LE(9000000000000001001n, 0);
  log.writeBigUInt64LE(90000000000001n, 8);
  log.writeUInt32LE(1, 0x10);
  log.writeBigUInt64LE(90000001n, 0x18);
  log.writeBigUInt64LE(bodyHeader + 32n, 0x30);
  const room = add(0x400000n, 0x200), info = add(0x500000n, 0x80);
  room.writeBigUInt64LE(base + 0x29c2ac8n);
  room.writeBigUInt64LE(0x500000n, 0x188);
  room.writeBigUInt64LE(logAddress - 0x20n, 0xe8);
  info.writeBigUInt64LE(base + 0x2a14788n);
  info.writeBigUInt64LE(90000000000001n, 0x18);
  user.writeBigUInt64LE(base + 0x280f948n, 0);
  user.writeBigUInt64LE(90000001n, 0x20);
  Buffer.from('테스터').copy(user, 0x38);
  user.writeBigUInt64LE(9n, 0x48); user.writeBigUInt64LE(15n, 0x50);
  function setText(text) {
    body.fill(0);
    const value = Buffer.from(text);
    body.writeBigUInt64LE(BigInt(value.length), 16);
    value.copy(body, 32);
  }
  setText(options.text || '새 문장 😀\n두 번째 줄');
  function memory(address, size) {
    for (const [start, data] of regions) if (address >= start && address + BigInt(size) <= start + BigInt(data.length)) {
      return data.subarray(Number(address - start), Number(address - start) + size);
    }
    throw new Error('Unmapped memory.');
  }
  class Pointer {
    constructor(value) { this.value = BigInt(value); }
    add(value) { return new Pointer(this.value + BigInt(value)); }
    sub(value) { return new Pointer(this.value - BigInt(value)); }
    equals(other) { return this.value === other.value; }
    isNull() { return this.value === 0n; }
    toString() { return '0x' + this.value.toString(16); }
    readPointer() { return new Pointer(this.readU64()); }
    readU64() { return memory(this.value, 8).readBigUInt64LE(); }
    readU32() { return memory(this.value, 4).readUInt32LE(); }
    readU8() { return memory(this.value, 1)[0]; }
    readByteArray(size) { return Uint8Array.from(memory(this.value, size)).buffer; }
    readUtf8String(size) { return new TextDecoder('utf-8', { fatal: true }).decode(memory(this.value, size)); }
  }
  let callback, tick;
  const sent = [];
  const clock = { now: Date.now() };
  class Clock extends Date { static now() { return clock.now; } }
  const sandbox = {
    Process: { arch: 'x64', pointerSize: 8, id: 9001,
      getModuleByName: () => ({ path: 'C:\\Program Files\\KakaoTalk\\KakaoTalk.exe', base: new Pointer(base) }) },
    Interceptor: {
      attach(address, callbacks) {
        assert.equal(address.value, target);
        callback = callbacks.onEnter;
        code[0] = 0xe9;
        return { detach() { original.copy(code); } };
      },
      flush() {}
    },
    ptr: value => new Pointer(value),
    uint64: value => ({compare: other => BigInt(value) < BigInt(other.toString()) ? -1 : BigInt(value) > BigInt(other.toString()) ? 1 : 0, toString:()=>String(value)}),
    send: value => sent.push(JSON.parse(JSON.stringify(value))),
    setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = null; },
    rpc: { exports: {} }, Date: Clock
  };
  vm.runInNewContext(source, sandbox);
  const config = { pid: 9001, path: 'C:\\Program Files\\KakaoTalk\\KakaoTalk.exe', roomId: '90000000000001', roomTitle: '테스터', duration: 60,
    profiles: [{ id: '90000001', address: '0x300000' }], baselineMessageIds: [], includeExisting: false, roomObject: '0x400000', processStartFileTime:'100', ...options.config };
  let allocation = 0x600000n;
  function allocate(size) { const at = allocation; allocation += BigInt(size + 64); return {at, bytes: add(at, size)}; }
  function string(value) { const text = Buffer.from(value), b = allocate(text.length + 33); b.bytes.writeBigUInt64LE(BigInt(text.length), 16); text.copy(b.bytes, 32); return b.at + 32n; }
  function variant(buffer, offset, value) {
    const tag = typeof value === 'string' ? 1 : typeof value === 'bigint' ? 3 : typeof value === 'boolean' ? 8 : Array.isArray(value) ? 5 : 4;
    buffer.writeUInt32LE(tag, offset); buffer.writeUInt32LE(0x7ffb, offset + 4);
    if (tag === 1) buffer.writeBigUInt64LE(string(value), offset + 16);
    if (tag === 3 || tag === 8) buffer.writeBigUInt64LE(BigInt(value), offset + 8);
    if (tag === 4) {
      const entries = Object.entries(value), map = allocate(32), head = allocate(32), nodes = entries.map(() => allocate(48));
      map.bytes.writeBigUInt64LE(head.at,16); map.bytes.writeBigUInt64LE(BigInt(nodes.length),24);
      head.bytes.writeBigUInt64LE(nodes[0]?.at || head.at,8);
      entries.forEach(([key,data], i) => {
        const n=nodes[i], item=allocate(32), k=string(key);
        n.bytes.writeBigUInt64LE(head.at,0);n.bytes.writeBigUInt64LE(nodes[i+1]?.at||head.at,16);
        n.bytes.writeBigUInt64LE(k,32);n.bytes.writeBigUInt64LE(item.at,40);item.bytes.writeBigUInt64LE(k,0);variant(item.bytes,8,data);
      });buffer.writeBigUInt64LE(map.at,offset+8);
    }
    if (tag === 5) {
      const header=allocate(24), items=allocate(Math.max(24,value.length*24));
      header.bytes.writeBigUInt64LE(items.at,0);header.bytes.writeBigUInt64LE(items.at+BigInt(value.length*24),8);header.bytes.writeBigUInt64LE(items.at+BigInt(value.length*24),16);
      value.forEach((item,i)=>variant(items.bytes,i*24,item));buffer.writeBigUInt64LE(header.at,offset+8);
    }
  }
  return { api: sandbox.rpc.exports, config, log, body, user, code, sent, clock, setText,
    attachment(type, value) { log.writeUInt32LE(type,0x10);variant(log,0xb8,value); },
    start() { return sandbox.rpc.exports.configure(config); },
    call() { callback([new Pointer(0), new Pointer(logAddress)]); }, tick() { if (tick) tick(); }
  };
}

test('copies unknown Korean/multiline/emoji text with exact 64-bit IDs', () => {
  const f = fixture(); f.start(); f.call(); f.tick();
  const event = f.sent[0].events[0];
  assert.equal(event.text, '새 문장 😀\n두 번째 줄');
  assert.equal(event.id, '9000000000000001001');
  assert.equal(event.senderId, '90000001');
  assert.equal(event.sender, '테스터');
  assert.equal(event.senderResolved, true);
  assert.equal(validateMessage(event).source, 'client');
});
test('history RPC reads an existing log without publishing it as a new arrival',()=>{
  const f=fixture();f.start();const value={pid:9001,session:'9001:100',roomId:f.config.roomId,before:'9000000000000001002',profiles:[],initialLogs:['0x100000','0x100000']};
  const events=f.api.history(value);assert.equal(events.length,1);assert.equal(events[0].id,'9000000000000001001');assert.equal(events[0].observation,'cache-snapshot');
  f.tick();assert.equal(f.sent.length,0);
  assert.equal(f.api.history({...value,before:events[0].id}).length,0);
  assert.throws(()=>f.api.history({...value,session:'9001:99'}));assert.throws(()=>f.api.history({...value,roomId:'2'}));
  f.log.writeBigUInt64LE(2n,8);assert.equal(f.api.history(value).length,0);
});

test('filters another room before reading its body', () => {
  const f = fixture(); f.start(); f.log.writeBigUInt64LE(1n, 8); f.log.writeBigUInt64LE(0n, 0x30); f.call();
  assert.equal(f.api.ping().counters.invalid, 0);
  assert.equal(f.api.stop().events.length, 0);
});

test('initial cache is marked as an observation and subsequent display calls are deduplicated', () => {
  const f = fixture({config: {initialSnapshot: true, baselineMessageIds: ['9000000000000001001']}});
  const ready = f.start();
  assert.equal(ready.snapshotState, 'captured');
  assert.equal(ready.functionEntryObserved, false);
  f.call();
  const result = f.api.stop();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].observation, 'cache-snapshot');
  assert.equal(result.events[0].timestampKind, 'observed');
  assert.equal(result.counters.snapshots, 1);
  assert.equal(result.counters.duplicates, 1);
});

test('suppresses known history and repeated calls', () => {
  const f = fixture({ config: { baselineMessageIds: ['9000000000000001001'] } }); f.start(); f.call();
  f.log.writeBigUInt64LE(9000000000000001002n); f.call(); f.call();
  const stopped = f.api.stop();
  assert.equal(stopped.events.length, 1);
  assert.equal(stopped.counters.duplicates, 2);
});

test('different IDs with identical bodies remain separate messages', () => {
  const f = fixture(); f.start(); f.call(); f.log.writeBigUInt64LE(9000000000000001002n); f.call();
  assert.equal(f.api.stop().events.length, 2);
});

test('rejects oversized strings, missing terminators and invalid UTF-8', () => {
  const f = fixture(); f.start(); f.body.writeBigUInt64LE(8193n, 16); f.call();
  f.setText('abc'); f.body[35] = 1; f.call();
  f.setText('abc'); f.body[32] = 0xff; f.call();
  const stopped = f.api.stop();
  assert.equal(stopped.counters.invalid, 3);
  assert.equal(stopped.events.length, 0);
});

test('unsupported message types are counted without body reads', () => {
  const f = fixture(); f.start(); f.log.writeUInt32LE(3, 0x10); f.log.writeBigUInt64LE(0n, 0x30); f.call();
  assert.equal(f.api.stop().counters.unsupported, 1);
});
test('photo events retain identity without reading a body or exposing a remote URL', () => {
  const f = fixture(); f.start(); f.log.writeUInt32LE(2, 0x10); f.log.writeBigUInt64LE(0n, 0x30); f.call();
  const event = validateMessage(f.api.stop().events[0]);
  assert.equal(event.kind, 'image'); assert.equal(event.text, '이미지');
  assert.equal(event.senderId, '90000001'); assert.equal(event.roomId, '90000000000001');
  assert.equal(event.url, undefined); assert.equal(event.attachment, undefined);
});

test('stale profile does not associate another person with the message', () => {
  const f = fixture(); f.start(); f.user.writeBigUInt64LE(777n, 0x20); f.call();
  const event = f.api.stop().events[0];
  assert.equal(event.senderResolved, false); assert.equal(event.sender, '90000001');
});

test('resolves a profile with the immutable TalkUser vtable', () => {
  const f = fixture(); f.user.writeBigUInt64LE(0x14280f918n); f.start(); f.call();
  const event = f.api.stop().events[0];
  assert.equal(event.senderResolved, true); assert.equal(event.sender, '테스터');
});

test('queue is bounded and batches require the matching acknowledgement', () => {
  const f = fixture(); f.start();
  for (let i = 0; i < 513; i++) { f.log.writeBigUInt64LE(9000000000000001001n + BigInt(i)); f.call(); }
  f.tick(); f.tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].events.length, 64);
  f.api.ack(999); f.tick(); assert.equal(f.sent.length, 1);
  f.api.ack(1); assert.equal(f.sent.length, 2);
  assert.equal(f.api.stop().counters.dropped, 1);
});

test('mismatched code is rejected before interception', () => {
  const f = fixture(); f.code[0] = 0xcc;
  assert.throws(() => f.start(), /Setter bytes differ/);
});

test('stop restores code and disables further capture', () => {
  const f = fixture(); f.start(); assert.equal(f.code[0], 0xe9);
  const result = f.api.stop(); assert.equal(result.restored, true);
  f.call(); assert.equal(f.api.ping().counters.captured, 0);
});

test('expired host heartbeat detaches the observer', () => {
  const f = fixture(); f.start(); f.clock.now += 11001; f.tick();
  assert.equal(f.sent[0].kind, 'stopped'); assert.equal(f.sent[0].reason, 'heartbeat-expired');
  assert.equal(f.sent[0].restored, true);
});

test('target identity and room selection are required', () => {
  assert.throws(() => fixture({ config: { pid: 42 } }).start(), /Unexpected target/);
  assert.throws(() => fixture({ config: { roomId: '*' } }).start(), /Invalid selected room/);
});

test('native reply copies reference IDs and original text despite enum padding', () => {
  const f=fixture();f.attachment(26,{src_logId:9000000000000002001n,src_userId:90000002n,src_type:1n,src_message:'원문 😀'});
  f.start();f.call();const event=validateMessage(f.api.stop().events[0]);
  assert.equal(event.kind,'reply');assert.equal(event.reply.id,'9000000000000002001');assert.equal(event.reply.text,'원문 😀');
});
test('card receiver emits full text, footer and inert web action metadata', () => {
  const f=fixture();f.attachment(72,{P:{PC:true},C:{TI:{TD:{T:'전체 본문\n안내',D:'하단 안내'}},BUL:[{BU:{T:'APP 바로가기 >'},L:{LPC:'https://example.com/card',LAT:'inweb'}},{BU:{T:'지원하지 않는 액션'},L:{LPC:'command:execute'}}]}});
  f.start();f.call();const event=validateMessage(f.api.stop().events[0]);
  assert.equal(event.kind,'card');assert.equal(event.text,'전체 본문\n안내');assert.equal(event.footer,'하단 안내');
  assert.equal(event.buttons[0].url,'https://example.com/card');assert.equal(event.buttons[1].url,undefined);
});
test('loaded reply history enters as a snapshot and malformed attachments are rejected', () => {
  const f=fixture({config:{initialSnapshot:true,initialLogs:['0x100000']}});
  f.attachment(26,{src_logId:7n,src_userId:8n,src_message:'원문'});f.start();
  assert.equal(f.api.stop().events[0].observation,'cache-snapshot');
  const broken=fixture();broken.attachment(26,{src_message:'참조 없는 본문'});broken.start();broken.call();
  assert.equal(broken.api.stop().events.length,0);assert.equal(broken.api.ping().counters.invalid,1);
});
