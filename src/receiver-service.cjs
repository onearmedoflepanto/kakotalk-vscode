'use strict';
const {EventEmitter} = require('node:events');
const {CollectorClient} = require('./collector-client.cjs');
const {RoomMonitor} = require('./room-monitor.cjs');
const {MessageStore, validateRoom} = require('./protocol.cjs');
const {validateImagePreview} = require('./image-preview.cjs');

// No editor APIs. The same service can be hosted by VS Code or Visual Studio.
class ReceiverService extends EventEmitter {
  constructor(root, {collector = new CollectorClient(root), monitor = new RoomMonitor(root), interval = 1000, debounceDelay = 10000} = {}) {
    super();
    Object.assign(this, {collector, monitor, interval, debounceDelay});
    this.store = new MessageStore(1000, true); this.rooms = []; this.baseline = new Map(); this.notices = new Map();
    this.selfId = ''; this.running = false; this.epoch = 0; this.connectEpoch = 0;
    collector.on('message', event => { if (this.store.add(event)) this.emit('message', event); });
    for (const name of ['ready', 'status', 'diagnostic', 'ended']) collector.on(name, value => this.emit(name, value));
  }
  setSelfId(value) {
    const selfId = typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n ? value : '';
    if (selfId === this.selfId) return;
    this.selfId = selfId; this.baseline.clear(); this.clearNotices(); this.emit('identity', {selfId});
  }
  observe(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.pid) || typeof snapshot.session !== 'string' || !Array.isArray(snapshot.rooms) || snapshot.rooms.length > 512) throw new Error('Invalid room snapshot.');
    const rooms = snapshot.rooms.map(validateRoom);
    const identity = snapshot.pid + ':' + snapshot.session;
    this.processIdentity = {pid: snapshot.pid, session: snapshot.session};
    if (this.identity !== identity) { this.identity = identity; this.baseline.clear(); this.clearNotices(); this.store.clear(); }
    this.setSelfId(snapshot.selfId);
    const next = new Map();
    for (const room of rooms) {
      const prior = this.baseline.get(room.id);
      next.set(room.id, prior?.lastMessageId && room.lastMessageId && BigInt(prior.lastMessageId) > BigInt(room.lastMessageId)
        ? {...room,lastMessageId:prior.lastMessageId} : room);
      if (!prior || !room.lastMessageId || !prior.lastMessageId || BigInt(room.lastMessageId) <= BigInt(prior.lastMessageId) || room.unreadCount < 1) continue;
      if (this.selfId && room.lastSenderId === this.selfId) continue;
      const previous = this.notices.get(room.id);
      clearTimeout(previous?.timer);
      this.notices.set(room.id, {roomId: room.id, roomTitle: room.title, lastMessageId: room.lastMessageId,
        count: (previous?.count || 0) + Math.max(1, room.unreadCount - prior.unreadCount), unreadCount: room.unreadCount,
        timer: setTimeout(() => this.flushNotice(room.id), this.debounceDelay)});
    }
    // A room absent from this observation is baselined again on its return.
    this.baseline = next;
    for (const id of this.notices.keys()) if (!(next.get(id)?.unreadCount > 0)) this.cancelNotice(id);
    this.rooms = rooms.sort((a, b) => (Date.parse(b.lastMessageAt) || 0) - (Date.parse(a.lastMessageAt) || 0) || a.id.localeCompare(b.id));
    this.emit('rooms', this.rooms);
  }
  cancelNotice(roomId) {
    clearTimeout(this.notices.get(roomId)?.timer);
    this.notices.delete(roomId);
  }
  clearNotices() { for (const id of this.notices.keys()) this.cancelNotice(id); }
  flushNotice(roomId) {
    const pending = this.notices.get(roomId);
    this.cancelNotice(roomId);
    if (pending && this.baseline.get(roomId)?.unreadCount > 0) {
      const {timer, ...notice} = pending;
      this.emit('notification', {rooms: [notice]});
    }
  }
  refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    this.refreshing = this.monitor.snapshot(force).then(snapshot => {
      if (epoch === this.epoch) this.observe(snapshot);
      return this.rooms;
    }).catch(error => {
      this.baseline.clear(); this.clearNotices(); this.setSelfId('');
      this.emit('diagnostic', {status: 'room-monitor-error', message: error.message}); throw error;
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(async () => { try { await this.refresh(); } catch (_) {} finally { this.schedule(); } }, this.interval);
  }
  async discover() { this.running = true; try { return await this.refresh(true); } finally { this.schedule(); } }
  async connect(request) {
    const token = ++this.connectEpoch;
    this.activeRoomId = '';
    await this.discover();
    if (token !== this.connectEpoch) return false;
    if (!this.rooms.some(room => room.id === request.roomId)) throw new Error('채팅방이 로컬 목록에 없습니다.');
    this.activeRoomId = request.roomId;
    try { return await this.collector.connect(request); }
    catch (error) { this.activeRoomId = ''; throw error; }
  }
  async history({roomId, before} = {}) {
    if (typeof before !== 'string' || !/^[1-9][0-9]{0,19}$/.test(before) || BigInt(before) > 18446744073709551615n ||
        roomId !== this.activeRoomId || !this.running || !this.processIdentity || this.historyPending) throw new Error('현재 대화에서 과거 메시지를 불러올 수 없습니다.');
    const cached = this.store.page(roomId, before);
    if (cached.length) return {messages: cached, scrolled: false, source: 'cache'};
    if (this.store.page(roomId, '', 1001).length >= 1000) return {messages: [], scrolled: false, source: 'cache', limit: true};
    const token = this.connectEpoch, identity = this.identity;
    const current = () => token === this.connectEpoch && identity === this.identity && this.running && this.activeRoomId === roomId;
    this.historyPending = true;
    let scrolled = false;
    try {
      const room = this.rooms.find(item => item.id === roomId);
      if (!room) throw new Error('채팅방이 로컬 목록에 없습니다.');
      // Inspect resident messages once, then advance the client in bounded wheel steps.
      for (let step = 0; step < 4; step++) {
        if (!current()) throw new Error('채팅방 연결이 변경되었습니다.');
        const metadata = await this.monitor.history({...this.processIdentity, roomId, roomTitle: room.title, before, scroll: step > 0});
        if (!current() || metadata.pid !== this.processIdentity.pid || metadata.session !== this.processIdentity.session || metadata.roomId !== roomId || metadata.before !== before) throw new Error('채팅방 연결이 변경되었습니다.');
        scrolled ||= metadata.scrolled === true;
        const events = await this.collector.history(metadata);
        if (!current()) throw new Error('채팅방 연결이 변경되었습니다.');
        for (const event of events) if (this.store.add(event)) this.emit('message', event);
        const messages = this.store.page(roomId, before);
        if (messages.length) return {messages, scrolled, source: 'client'};
      }
      return {messages: [], scrolled, source: 'client'};
    } finally { this.historyPending = false; }
  }
  async imagePreview({roomId, messageId} = {}) {
    const message = this.store.snapshot().find(item => item.roomId === roomId && item.id === messageId && item.kind === 'image');
    if (!this.running || !this.processIdentity || !message?.senderId || this.previewPending) throw new Error('이미지 미리보기를 불러올 수 없습니다.');
    const epoch = this.epoch, identity = this.identity;
    this.previewPending = true;
    try {
      const result = await this.monitor.imagePreview({...this.processIdentity, roomId, messageId, senderId: message.senderId});
      if (epoch !== this.epoch || identity !== this.identity) throw new Error('Client session changed.');
      return validateImagePreview(result);
    } finally { this.previewPending = false; }
  }
  async stop({monitor = true} = {}) {
    ++this.connectEpoch;
    this.activeRoomId = '';
    if (monitor) {
      this.running = false; ++this.epoch; clearTimeout(this.timer);
      this.baseline.clear(); this.clearNotices(); this.setSelfId('');
      this.store.clear();
      await this.monitor.stop();
    }
    return await this.collector.stop() || {clean: true};
  }
  async dispose() { await this.stop(); await this.collector.dispose(); this.removeAllListeners(); }
}
module.exports = {ReceiverService};
