'use strict';

const {TextDecoder} = require('node:util');
const MAX_FRAME = 128 * 1024;

function field(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`Invalid message field: ${name}`);
  }
  return value;
}

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function validateRoom(value) {
  const id = field(value?.id, 'room ID', 20);
  if (!/^[1-9][0-9]{0,19}$/.test(id) || !Number.isInteger(value.unreadCount) || value.unreadCount < 0 || value.unreadCount > 1000000000) throw new Error('Invalid room state.');
  for (const key of ['lastMessageId', 'lastSenderId']) if (value[key] != null && !/^[1-9][0-9]{0,19}$/.test(value[key])) throw new Error('Invalid room identity.');
  if (value.lastMessageAt != null && !Number.isFinite(Date.parse(value.lastMessageAt))) throw new Error('Invalid room timestamp.');
  return Object.freeze({id, title: field(value.title, 'room title', 256), unreadCount: value.unreadCount,
    lastMessageId: value.lastMessageId || null, lastSenderId: value.lastSenderId || null, lastMessageAt: value.lastMessageAt || null});
}

function validateMessage(value) {
  if (!value || value.version !== 1 || value.type !== 'message' ||
      value.source !== 'client') throw new Error('Unsupported message event.');
  const timestamp = field(value.timestamp, 'timestamp', 40);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp.');
  // Copy only the public contract; do not retain unrelated native payload fields.
  if (value.timestampKind !== undefined && !['observed', 'sent'].includes(value.timestampKind)) throw new Error('Invalid timestamp kind.');
  if (value.observation !== undefined && !['ui-model-setter', 'cache-snapshot'].includes(value.observation)) throw new Error('Invalid observation kind.');
  if (value.senderResolved !== undefined && typeof value.senderResolved !== 'boolean') throw new Error('Invalid sender resolution.');
   const kind = value.kind || 'text';
   if (!['text', 'reply', 'card', 'image'].includes(kind)) throw new Error('Invalid message kind.');
   let reply;
   if (value.reply !== undefined) {
     const r = value.reply;
     reply = Object.freeze({id: field(r.id, 'reply ID', 20), senderId: field(r.senderId, 'reply sender', 20), text: field(r.text, 'reply text', 8192)});
     if (!/^\d+$/.test(reply.id) || !/^\d+$/.test(reply.senderId) || kind !== 'reply') throw new Error('Invalid reply reference.');
   }
   if (value.buttons !== undefined && (!Array.isArray(value.buttons) || value.buttons.length > 10)) throw new Error('Invalid action buttons.');
   const buttons = (value.buttons || []).map((button, index) => Object.freeze({id: String(index), label: field(button.label, 'button label', 100),
     ...(httpUrl(button.url) ? {url: httpUrl(button.url)} : {})}));
   return Object.freeze({
    version: 1, type: 'message', source: value.source,
    id: field(value.id, 'id', 256),
    roomId: field(value.roomId, 'roomId', 256),
    roomTitle: field(value.roomTitle, 'roomTitle', 256),
    sender: field(value.sender, 'sender', 256),
    ...(value.senderId === undefined ? {} : {senderId: field(value.senderId, 'senderId', 256)}),
    ...(value.timestampKind === undefined ? {} : {timestampKind: value.timestampKind}),
    ...(value.observation === undefined ? {} : {observation: value.observation}),
    ...(value.senderResolved === undefined ? {} : {senderResolved: value.senderResolved}),
     text: kind === 'image' ? '이미지' : field(value.text, 'text', 16384), timestamp,
     ...(kind === 'text' ? {} : {kind}), ...(reply ? {reply} : {}),
     ...(buttons.length ? {buttons: Object.freeze(buttons)} : {}),
     ...(value.footer ? {footer: field(value.footer, 'card footer', 2048)} : {})
  });
}

class MessageDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.pending = Buffer.alloc(0);
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) throw new Error('Decoder is closed after an invalid event.');
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(offset, end);
        if (this.pending.length + part.length > MAX_FRAME) throw new Error('Message event exceeds size limit.');
        this.pending = Buffer.concat([this.pending, part]);
        if (newline < 0) break;
        const line = new TextDecoder('utf-8', {fatal: true}).decode(this.pending);
        this.pending = Buffer.alloc(0);
        if (line.trim()) this.onMessage(validateMessage(JSON.parse(line)));
        offset = newline + 1;
      }
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }
  finish() {
    if (this.pending.length) throw new Error('Connection closed during a message event.');
  }
}

class MessageStore {
  constructor(limit = 300, perRoom = false) {
    this.limit = limit;
    this.perRoom = perRoom;
    this.clear();
  }
  clear() { this.messages = []; this.keys = new Set(); }
  add(value) {
    const message = validateMessage(value);
    const key = JSON.stringify([message.source, message.roomId, message.id]);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.messages.push(message);
    let room = this.perRoom ? this.messages.filter(item => item.source === message.source && item.roomId === message.roomId).sort(messageOrder) : this.messages;
    while (room.length > this.limit || this.messages.length > (this.perRoom ? this.limit * 16 : this.limit)) {
      const oldest = room.length > this.limit ? room[0] : this.messages[0];
      this.messages.splice(this.messages.indexOf(oldest), 1);
      if (room !== this.messages) room = room.filter(item => item !== oldest);
      this.keys.delete(JSON.stringify([oldest.source, oldest.roomId, oldest.id]));
    }
    return true;
  }
  snapshot() { return [...this.messages]; }
  page(roomId, before, count = 10) {
    return this.messages.filter(item => item.source === 'client' && item.roomId === roomId && (!before || BigInt(item.id) < BigInt(before)))
      .sort(messageOrder).slice(-count);
  }
}
function messageOrder(a, b) {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  return Date.parse(a.timestamp) - Date.parse(b.timestamp);
}

module.exports = {MAX_FRAME, MessageDecoder, MessageStore, validateMessage, validateRoom, httpUrl};
