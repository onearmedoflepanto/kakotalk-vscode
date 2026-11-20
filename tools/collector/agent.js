'use strict';

// Only the local UI model setter is observed. Arguments and return values are
// never replaced, and no KakaoTalk function or network API is called here.
const SETTER_RVA = Number(CLIENT_BUILD.setter);
const PROLOGUE = '48895c2418555657415441554156415748';
const USER_VTABLE_RVA = Number(CLIENT_BUILD.tables.TalkUser_Mutable);
const IMMUTABLE_USER_VTABLE_RVA = Number(CLIENT_BUILD.tables.TalkUser);
const MAX_BODY_BYTES = 8192;
const MAX_QUEUE = 512;
const MAX_SEEN = 16384;
let listener = null;
let timer = null;
let configuration = null;
let moduleBase = null;
let target = null;
let active = false;
let startedAt = 0;
let heartbeatAt = 0;
let sequence = 0;
let inFlight = null;
const pending = [];
const seen = new Set();
const profiles = new Map();
const counters = { calls: 0, roomCalls: 0, captured: 0, snapshots: 0, duplicates: 0, unsupported: 0, invalid: 0, dropped: 0, unresolvedSenders: 0 };

function bytesHex(address, length) {
  return Array.from(new Uint8Array(address.readByteArray(length)), b => b.toString(16).padStart(2, '0')).join('');
}

function readBody(address) {
  const pointer = address.add(0x30).readPointer();
  if (pointer.isNull()) throw new Error('Missing text pointer.');
  const length = Number(pointer.sub(0x10).readU64().toString());
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY_BYTES || pointer.add(length).readU8() !== 0) {
    throw new Error('Invalid text boundary.');
  }
  const text = pointer.readUtf8String(length);
  if (!text || text.includes('\0') || !address.add(0x30).readPointer().equals(pointer) ||
      pointer.sub(0x10).readU64().toString() !== String(length)) throw new Error('Text changed during copy.');
  return text;
}

function attachmentString(pointer, budget) {
  if (pointer.isNull()) throw new Error('Missing attachment string.');
  const length = Number(pointer.sub(16).readU64().toString());
  if (!Number.isSafeInteger(length) || length < 0 || length > 16384 || (budget.characters += length) > 65536 || pointer.add(length).readU8() !== 0) throw new Error('Attachment string limit.');
  const value = length ? pointer.readUtf8String(length) : '';
  if (pointer.sub(16).readU64().toString() !== String(length) || value.includes('\0')) throw new Error('Attachment string changed.');
  return value;
}

function readVariant(address, budget, depth = 0) {
  if (depth > 10 || ++budget.nodes > 512) throw new Error('Attachment traversal limit.');
  const tag = address.readU32(); // The following four bytes are native padding.
  const data = address.add(8).readPointer(), text = address.add(16).readPointer();
  let result = null;
  if (tag === 1) result = attachmentString(text, budget);
  else if (tag === 3) result = address.add(8).readU64().toString();
  else if (tag === 8) result = address.add(8).readU8() !== 0;
  else if (tag === 4) {
    const head = data.add(16).readPointer(), count = Number(data.add(24).readU64().toString());
    if (!Number.isSafeInteger(count) || count < 0 || count > 128) throw new Error('Attachment map limit.');
    result = Object.create(null);
    const pendingNodes = count ? [head.add(8).readPointer()] : [], visited = new Set();
    while (pendingNodes.length) {
      const node = pendingNodes.pop();
      if (node.equals(head)) continue;
      if (node.isNull() || visited.has(node.toString()) || visited.size >= count) throw new Error('Invalid attachment tree.');
      visited.add(node.toString());
      const key = attachmentString(node.add(32).readPointer(), budget), item = node.add(40).readPointer();
      if (!key || key.length > 100 || key !== attachmentString(item.readPointer(), budget) || Object.prototype.hasOwnProperty.call(result, key)) throw new Error('Attachment key mismatch.');
      result[key] = readVariant(item.add(8), budget, depth + 1);
      pendingNodes.push(node.readPointer(), node.add(16).readPointer());
    }
    if (visited.size !== count || !data.add(16).readPointer().equals(head) || data.add(24).readU64().toString() !== String(count)) throw new Error('Attachment map changed.');
  } else if (tag === 5) {
    const begin = data.readPointer(), end = data.add(8).readPointer(), capacity = data.add(16).readPointer();
    // Native vector<Variant> has 24-byte elements. Walk a bounded number without narrowing pointers.
    result = []; let at = begin;
    while (!at.equals(end) && result.length < 128) { result.push(readVariant(at, budget, depth + 1)); at = at.add(24); }
    if (!at.equals(end) || !data.readPointer().equals(begin) || !data.add(8).readPointer().equals(end) || !data.add(16).readPointer().equals(capacity)) throw new Error('Attachment array changed or exceeds limit.');
  }
  if (address.readU32() !== tag || !address.add(8).readPointer().equals(data) || !address.add(16).readPointer().equals(text)) throw new Error('Attachment changed.');
  return result;
}

function richContent(log, type, text) {
  if (type === 1) return {text};
  if (type === 2) return {kind: 'image', text: '이미지'};
  const attachment = readVariant(log.add(0xb8), {nodes: 0, characters: 0});
  if (!attachment || typeof attachment !== 'object') throw new Error('Missing structured content.');
  if (type === 26) {
    if (!/^[1-9][0-9]{0,19}$/.test(attachment.src_logId) || !/^[1-9][0-9]{0,19}$/.test(attachment.src_userId) || typeof attachment.src_message !== 'string' || !attachment.src_message.trim()) throw new Error('Invalid reply reference.');
    return {kind: 'reply', text, reply: {id: attachment.src_logId, senderId: attachment.src_userId, text: attachment.src_message}};
  }
  const card = attachment.C;
  if (!card || typeof card.TI?.TD?.T !== 'string' || !card.TI.TD.T.trim()) throw new Error('Unsupported card layout.');
  const buttons = Array.isArray(card.BUL) ? card.BUL.slice(0, 10).flatMap((button, index) => {
    if (typeof button?.BU?.T !== 'string' || !button.BU.T.trim() || button.BU.T.length > 100) return [];
    const url = typeof button.L?.LPC === 'string' && /^https?:\/\//i.test(button.L.LPC) ? button.L.LPC : undefined;
    return [{id: String(index), label: button.BU.T, ...(url ? {url} : {})}];
  }) : [];
  return {kind: 'card', text: card.TI.TD.T, ...(typeof card.TI.TD.D === 'string' && card.TI.TD.D ? {footer: card.TI.TD.D} : {}), buttons};
}

function senderName(senderId) {
  try {
    const user = profiles.get(senderId);
    if (!user) return null;
    const userTable = user.readPointer();
    if ((!userTable.equals(moduleBase.add(USER_VTABLE_RVA)) && !userTable.equals(moduleBase.add(IMMUTABLE_USER_VTABLE_RVA))) || user.add(0x20).readU64().toString() !== senderId) return null;
    const value = user.add(0x38);
    const size = Number(value.add(16).readU64().toString());
    const capacity = Number(value.add(24).readU64().toString());
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024 || !Number.isSafeInteger(capacity) || capacity < size || capacity > 1048576) return null;
    const data = capacity <= 15 ? value : value.readPointer();
    if (data.add(size).readU8() !== 0) return null;
    const name = data.readUtf8String(size);
    if (!name || name.length > 256 || name.includes('\0') || value.add(16).readU64().toString() !== String(size) ||
        user.add(0x20).readU64().toString() !== senderId) return null;
    return name;
  } catch (_) { return null; }
}

function remember(key) {
  seen.add(key);
  while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
}

function capture(args) {
  counters.calls++;
  captureLog(args[1], 'ui-model-setter');
}

function captureLog(log, observation, publish = true) {
  if (!active) return;
  try {
    if (log.isNull()) return;
    const roomId = log.add(8).readU64().toString();
    if (roomId !== configuration.roomId) return;
    counters.roomCalls++;
    const type = log.add(0x10).readU32();
    if (![1, 2, 26, 72].includes(type)) { counters.unsupported++; return; }
    const id = log.readU64().toString();
    const senderId = log.add(0x18).readU64().toString();
    if (id === '0' || senderId === '0') throw new Error('Missing message identity.');
    const key = roomId + ':' + id;
    if (seen.has(key) && observation !== 'cache-snapshot') { counters.duplicates++; return; }
    if (publish && pending.length >= MAX_QUEUE) { counters.dropped++; return; }
    const content = richContent(log, type, type === 2 ? '' : readBody(log));
    if (log.readU64().toString() !== id || log.add(8).readU64().toString() !== roomId || log.add(0x18).readU64().toString() !== senderId) {
      throw new Error('Message changed during copy.');
    }
    const resolved = senderName(senderId);
    if (resolved === null) counters.unresolvedSenders++;
    const seconds = log.add(0x20).readU32();
    const sentAt = seconds >= 946684800 && seconds * 1000 <= Date.now() + 86400000 ? new Date(seconds * 1000).toISOString() : null;
    const event = { version: 1, type: 'message', source: 'client', id, roomId,
      roomTitle: configuration.roomTitle, senderId, sender: resolved || senderId,
      senderResolved: resolved !== null, ...content, timestamp: sentAt || new Date().toISOString(),
      timestampKind: sentAt ? 'sent' : 'observed', observation };
    if (!publish) return event;
    pending.push(event);
    remember(key);
    counters.captured++;
    if (observation === 'cache-snapshot') counters.snapshots++;
  } catch (_) { counters.invalid++; }
}

function flush() {
  if (inFlight !== null || pending.length === 0) return;
  inFlight = { kind: 'batch', sequence: ++sequence, events: pending.splice(0, 64) };
  send(inFlight);
}

function stop(reason) {
  if (listener !== null) { listener.detach(); listener = null; Interceptor.flush(); }
  active = false;
  if (timer !== null) { clearInterval(timer); timer = null; }
  let restored = false;
  try { restored = target !== null && bytesHex(target, PROLOGUE.length / 2) === PROLOGUE; } catch (_) {}
  const events = (inFlight === null ? [] : inFlight.events).concat(pending.splice(0));
  inFlight = null;
  return { reason, restored, counters: { ...counters }, events };
}

rpc.exports = {
  configure(value) {
    if (configuration !== null) throw new Error('This observer session has already been configured.');
    if (Process.arch !== 'x64' || Process.pointerSize !== 8 || Process.id !== value.pid) throw new Error('Unexpected target process.');
    const module = Process.getModuleByName('KakaoTalk.exe');
    if (module.path.toLowerCase().replace(/\//g, '\\') !== value.path.toLowerCase().replace(/\//g, '\\')) throw new Error('Unexpected target path.');
    if (!/^[1-9][0-9]{0,19}$/.test(value.roomId) || typeof value.roomTitle !== 'string' || !value.roomTitle.trim() || value.roomTitle.length > 256) throw new Error('Invalid selected room.');
    if (!Number.isInteger(value.duration) || value.duration < 1 || value.duration > 3600) throw new Error('Duration must be 1..3600 seconds.');
    if (!Array.isArray(value.profiles) || value.profiles.length > 16384 || !Array.isArray(value.baselineMessageIds) || value.baselineMessageIds.length > MAX_SEEN) throw new Error('Invalid discovery metadata.');
    moduleBase = module.base;
    target = moduleBase.add(SETTER_RVA);
    if (bytesHex(target, PROLOGUE.length / 2) !== PROLOGUE) throw new Error('Setter bytes differ from the analyzed build or another hook is installed.');
    for (const entry of value.profiles) {
      if (!/^[1-9][0-9]{0,19}$/.test(entry.id) || !/^0x[0-9a-f]+$/i.test(entry.address)) throw new Error('Invalid profile reference.');
      profiles.set(entry.id, ptr(entry.address));
    }
    if (!value.includeExisting) for (const id of value.baselineMessageIds) {
      if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new Error('Invalid baseline ID.');
      remember(value.roomId + ':' + id);
    }
    configuration = value;
    startedAt = heartbeatAt = Date.now();
    listener = Interceptor.attach(target, { onEnter: capture });
    Interceptor.flush();
    active = true;
    let snapshotState = 'not-requested';
    if (value.initialSnapshot && Array.isArray(value.initialLogs)) {
      if (value.initialLogs.length > 100) throw new Error('Initial message limit.');
      for (const address of value.initialLogs) {
        if (!/^0x[0-9a-f]+$/i.test(address)) throw new Error('Invalid initial message address.');
        captureLog(ptr(address), 'cache-snapshot');
      }
    }
    if (value.initialSnapshot && /^0x[0-9a-f]+$/i.test(value.roomObject || '')) {
      try {
        const room = ptr(value.roomObject);
        const info = room.add(0x188).readPointer();
        snapshotState = 'room-object-changed';
        if (room.readPointer().equals(moduleBase.add(Number(CLIENT_BUILD.tables.TalkChatRoom))) && info.readPointer().equals(moduleBase.add(Number(CLIENT_BUILD.tables.TalkChatRoomInfo_Mutable))) &&
            info.add(0x18).readU64().toString() === value.roomId) {
          captureLog(room.add(0xe8).readPointer().add(0x20), 'cache-snapshot');
          snapshotState = counters.snapshots ? 'captured' : 'no-text-cache';
        }
      } catch (_) { counters.invalid++; }
    }
    timer = setInterval(() => {
      const now = Date.now();
      if (now - heartbeatAt > 10000 || now - startedAt >= configuration.duration * 1000) {
        const result = stop(now - heartbeatAt > 10000 ? 'heartbeat-expired' : 'duration-ended');
        send({ kind: 'stopped', ...result });
      } else { flush(); }
    }, 50);
    return { attached: true, pid: Process.id, roomId: value.roomId, setterRva: CLIENT_BUILD.setter, clientVersion: CLIENT_BUILD.version, baselineCount: seen.size, snapshotState, functionEntryObserved: false };
  },
  history(value) {
    if (!active || value.pid !== Process.id || value.roomId !== configuration.roomId ||
        value.session !== String(Process.id) + ':' + configuration.processStartFileTime || !/^[1-9][0-9]{0,19}$/.test(value.before) ||
        !Array.isArray(value.initialLogs) || value.initialLogs.length > 100 || !Array.isArray(value.profiles) || value.profiles.length > 16384) throw new Error('History session changed.');
    for (const entry of value.profiles) {
      if (!/^[1-9][0-9]{0,19}$/.test(entry.id) || !/^0x[0-9a-f]+$/i.test(entry.address)) throw new Error('Invalid profile reference.');
      profiles.set(entry.id, ptr(entry.address));
    }
    const result = new Map(), before = uint64(value.before);
    for (const address of value.initialLogs) {
      if (!/^0x[0-9a-f]+$/i.test(address)) throw new Error('Invalid history address.');
      const event = captureLog(ptr(address), 'cache-snapshot', false);
      if (event && uint64(event.id).compare(before) < 0) result.set(event.id, event);
    }
    const events = []; let bytes = 0;
    for (const event of [...result.values()].sort((a, b) => uint64(b.id).compare(uint64(a.id)))) {
      bytes += JSON.stringify(event).length * 3;
      if (bytes > 512 * 1024) break;
      events.push(event);
    }
    return events.reverse();
  },
  ping() { heartbeatAt = Date.now(); return { active, counters: { ...counters } }; },
  ack(value) { if (inFlight !== null && inFlight.sequence === value) { inFlight = null; flush(); } },
  stop() { return stop('host-stop'); }
};
