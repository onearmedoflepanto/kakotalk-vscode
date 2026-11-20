'use strict';

const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const messages = byId('messages');
const saved = vscode.getState() || {};
let selectedRoom = typeof saved.selectedRoom === 'string' ? saved.selectedRoom : '';
let screen = saved.screen === 'conversation' ? 'conversation' : 'home';
let snapshot = {messages: [], mode: 'idle', selfId: ''};
let rooms = [];
let pendingRoomId = '';
let lastActiveRoomId = '';
const drafts = new Map();
const replyTargets = new Map();
let pendingSend;
let sendSequence = 0;
let sendError = '';
let visibleKey = '';
let previewSequence = 0, activePreview, previewTimer;
const imagePreviews = new Map();
let historyRequested = false, historyAttemptAt = 0, previousScrollTop = 0, renderedRoom = '';

function loadHistory(manual = false) {
  if (historyRequested || snapshot.history?.loading || snapshot.history?.limit || snapshot.busy || snapshot.sending || pendingSend || snapshot.roomPicker?.open ||
      snapshot.mode !== 'live' || screen !== 'conversation' || (!manual && (snapshot.history?.empty || snapshot.history?.error)) || Date.now() - historyAttemptAt < 500) return;
  const before = messages.querySelector('article')?.dataset.messageId;
  if (!before || selectedRoom !== JSON.stringify(['client', snapshot.activeRoomId])) return;
  historyRequested = true; historyAttemptAt = Date.now();
  vscode.postMessage({type: 'history', roomId: snapshot.activeRoomId, before});
}
messages.addEventListener('wheel', event => { if (event.deltaY < 0 && messages.scrollTop <= 60) loadHistory(); }, {passive: true});
messages.addEventListener('scroll', () => {
  const top = messages.scrollTop;
  if (top < previousScrollTop && top <= 60) loadHistory();
  previousScrollTop = top;
});

function hideImagePreview() {
  clearTimeout(previewTimer); activePreview = undefined;
  byId('image-preview').hidden = true;
  byId('image-preview-content').hidden = true;
  byId('image-preview-content').removeAttribute('src');
}
function positionImagePreview() {
  if (!activePreview?.anchor.isConnected) return hideImagePreview();
  const popup = byId('image-preview'), anchor = activePreview.anchor.getBoundingClientRect();
  const top = anchor.bottom + 8 + popup.offsetHeight <= innerHeight - 8 ? anchor.bottom + 8 : Math.max(8, anchor.top - popup.offsetHeight - 8);
  popup.style.top = `${top}px`;
  popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - popup.offsetWidth - 8))}px`;
}
function showPreviewImage(image) {
  const element = byId('image-preview-content');
  byId('image-preview-status').textContent = '';
  element.src = `data:${image.mime};base64,${image.data}`;
  element.hidden = false;
  positionImagePreview();
}
function showImagePreview(message, anchor) {
  if (activePreview?.messageId === message.id && activePreview.roomId === message.roomId) { activePreview.anchor = anchor; return; }
  hideImagePreview();
  const key = JSON.stringify([message.roomId, message.id]);
  const requestId = String(++previewSequence);
  activePreview = {key, roomId: message.roomId, messageId: message.id, requestId, anchor};
  previewTimer = setTimeout(() => {
    if (activePreview?.requestId !== requestId) return;
    byId('image-preview').hidden = false;
    byId('image-preview-status').textContent = '불러오는 중…';
    positionImagePreview();
    const image = imagePreviews.get(key);
    if (image) showPreviewImage(image);
    else vscode.postMessage({type: 'image-preview', roomId: message.roomId, messageId: message.id, requestId});
  }, 120);
}
byId('image-preview-content').addEventListener('load', positionImagePreview);
byId('image-preview-content').addEventListener('error', () => {
  if (!activePreview) return;
  imagePreviews.delete(activePreview.key);
  byId('image-preview-content').hidden = true;
  byId('image-preview-status').textContent = '미리보기를 불러올 수 없습니다.';
  positionImagePreview();
});
messages.addEventListener('scroll', hideImagePreview);
window.addEventListener('resize', hideImagePreview);

function renderIndicator() {
  const dot = byId('status-dot');
  const pending = Boolean(pendingSend || snapshot.sending || snapshot.busy || snapshot.history?.loading || snapshot.roomPicker?.loading);
  const error = sendError || snapshot.roomPicker?.error || '';
  const status = pendingSend || snapshot.sending ? '전송 확인 중' : snapshot.roomPicker?.loading ? '채팅방 조회 중' : snapshot.status || '연결 안 됨';
  const label = [status, error || snapshot.warning].filter(Boolean).join(' · ');
  dot.title = label;
  dot.setAttribute('aria-label', label);
  dot.classList.toggle('connected', snapshot.status === '로컬 수신 연결됨');
  dot.classList.toggle('pending', pending);
  dot.classList.toggle('warning', Boolean(snapshot.warning));
  dot.classList.toggle('error', Boolean(error || snapshot.status?.includes('실패')));
}

function renderComposer() {
  const enabled = Boolean((snapshot.canSend || snapshot.sending || pendingSend) && !snapshot.roomPicker?.open && screen === 'conversation' && selectedRoom === JSON.stringify(['client', snapshot.activeRoomId]));
  byId('draft').disabled = !enabled;
  const value = drafts.get(selectedRoom) || '';
  const target = replyTargets.get(selectedRoom);
  byId('reply-draft').hidden = !target || screen !== 'conversation';
  byId('reply-title').textContent = target ? `${target.sender}에게 답장` : '';
  byId('reply-text').textContent = target?.text || '';
  byId('draft').maxLength = target ? 500 : 2000;
  byId('draft').placeholder = target ? '답장 입력' : '메시지 입력';
  if (byId('draft').value !== value) byId('draft').value = value;
  byId('send').disabled = !enabled || Boolean(snapshot.sending || pendingSend || snapshot.history?.loading) || !value.trim() || value.length > (target ? 500 : 2000);
  byId('toggleSending').textContent = snapshot.sendingEnabled ? '답장 기능 끄기' : '답장 기능 켜기';
  renderIndicator();
}

function submitDraft() {
  if (byId('send').disabled || pendingSend) return;
  const [source, roomId] = JSON.parse(selectedRoom);
  pendingSend = {requestId: String(++sendSequence), key: selectedRoom, text: byId('draft').value, replyTo:replyTargets.get(selectedRoom)?.id};
  sendError = '';
  vscode.postMessage({type: 'send', source, roomId, text: pendingSend.text, requestId: pendingSend.requestId, ...(pendingSend.replyTo ? {replyTo:pendingSend.replyTo} : {})});
  renderComposer();
  byId('draft').focus({preventScroll: true});
}

const roomKey = message => JSON.stringify([message.source, message.roomId]);
const senderName = message => snapshot.selfId && message.senderId === snapshot.selfId ? '나' :
  message.senderResolved === false || message.sender === message.senderId ? '알 수 없는 발신자' : message.sender;
const persist = () => vscode.setState({selectedRoom, screen});

function closeMenu(restoreFocus = false) {
  const wasOpen = !byId('actions-menu').hidden;
  byId('actions-menu').hidden = true;
  byId('composer-menu').setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) byId('composer-menu').focus();
}

function toggleMenu() {
  const opening = byId('actions-menu').hidden;
  closeMenu();
  if (!opening) return;
  byId('actions-menu').hidden = false;
  byId('composer-menu').setAttribute('aria-expanded', 'true');
  byId('actions-menu').querySelector('button:not(:disabled)')?.focus();
}

function showHome() {
  screen = 'home';
  byId('room-search').value = '';
  closeMenu();
  persist();
  render();
  vscode.postMessage({type: 'rooms'});
  byId('room-search').focus();
}

function openRoom(key) {
  selectedRoom = key;
  screen = 'conversation';
  closeMenu();
  persist();
  render(true);
  const [source, roomId] = JSON.parse(key);
  if (source === 'client') vscode.postMessage({type: 'selectRoom', roomId});
  messages.focus({preventScroll: true});
}

function age(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 60000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function roomButton(room) {
  const button = document.createElement('button');
  button.className = 'room-row';
  button.title = room.title;
  button.disabled = Boolean(snapshot.busy || snapshot.sending || snapshot.roomPicker?.loading);
  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = room.title;
  const label = document.createElement('span');
  label.className = 'room-label';
  label.append(name);
  button.append(label);
  if (room.unreadCount > 0) {
    const badge = document.createElement('span'); badge.className = 'unread-count';
    badge.textContent = room.unreadCount > 999 ? '999+' : String(room.unreadCount);
    badge.setAttribute('aria-label', `읽지 않은 메시지 ${room.unreadCount}개`); button.append(badge);
  }
  if (room.timestamp) {
    const time = document.createElement('time');
    time.className = 'room-age';
    time.dateTime = room.timestamp;
    time.title = new Date(room.timestamp).toLocaleString('ko-KR');
    time.textContent = age(room.timestamp);
    button.append(time);
  }
  button.addEventListener('click', () => openRoom(room.key));
  return button;
}

function renderRooms() {
  const picker = snapshot.roomPicker;
  const query = byId('room-search').value.trim().toLocaleLowerCase();
  const available = rooms.filter(room => room.title.toLocaleLowerCase().includes(query));
  const text = picker?.loading ? '채팅방을 불러오는 중…' : snapshot.busy ? '채팅방에 연결하는 중…' : picker?.error ||
    (!rooms.length ? 'PC카톡에서 채팅방을 연 뒤 새로고침하세요.' : !available.length ? '검색 결과가 없습니다.' : '');
  byId('room-list-status').textContent = text;
  byId('room-list-status').hidden = !text;
  byId('room-list').setAttribute('aria-busy', String(Boolean(picker?.loading || snapshot.busy)));
  byId('refresh-rooms').disabled = Boolean(picker?.loading || snapshot.busy || snapshot.sending);
  byId('room-list').replaceChildren(...available.map(room => roomButton(room)));
}

function renderMessages(forceScroll) {
  const previousTop = messages.scrollTop;
  const sameRoom = renderedRoom === selectedRoom;
  const oldFirst = sameRoom ? messages.querySelector('article')?.dataset.messageId : '';
  const top = messages.getBoundingClientRect().top;
  const anchor = sameRoom ? [...messages.querySelectorAll('article')].find(item => item.getBoundingClientRect().bottom > top) : undefined;
  const anchorId = anchor?.dataset.messageId, anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const atBottom = messages.scrollHeight - messages.clientHeight - previousTop < 50;
  let visible = snapshot.messages.filter(message => roomKey(message) === selectedRoom).sort((a, b) => {
    if (a.source === 'client' && /^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
      const left = BigInt(a.id), right = BigInt(b.id);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });
  visible = snapshot.history?.floor ? visible.filter(item => BigInt(item.id) >= BigInt(snapshot.history.floor)) : visible.slice(-10);
  const elements = visible.map(message => {
    const outgoing = Boolean(snapshot.selfId && message.senderId === snapshot.selfId);
    const article = document.createElement('article');
    article.className = `message ${outgoing ? 'outgoing' : 'incoming'}`;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = senderName(message);
    const time = document.createElement('time');
    time.dateTime = message.timestamp;
    const observed = message.timestampKind === 'observed';
    time.title = `${observed ? '클라이언트에서 확인한 시각 · ' : ''}${new Date(message.timestamp).toLocaleString('ko-KR')}${message.observation === 'cache-snapshot' ? ' · 기존 캐시 메시지' : ''}`;
    time.textContent = `${message.observation === 'cache-snapshot' ? '기존 · ' : ''}${observed ? '확인 ' : ''}${new Date(message.timestamp).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit'})}`;
    meta.append(sender, time);
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.text;
    if (message.kind === 'image') {
      const label = document.createElement('button');
      label.className = 'image-label'; label.textContent = '이미지';
      label.setAttribute('aria-label', '이미지 미리보기'); label.setAttribute('aria-describedby', 'image-preview');
      label.dataset.imageId = message.id;
      label.addEventListener('mouseenter', () => showImagePreview(message, label));
      label.addEventListener('focus', () => showImagePreview(message, label));
      label.addEventListener('mouseleave', hideImagePreview);
      label.addEventListener('blur', hideImagePreview);
      body.replaceChildren(label);
    }
    article.append(meta);
    if (message.reply) {
      const original = snapshot.messages.find(m => m.roomId === message.roomId && m.id === message.reply.id);
      const quote = document.createElement('button'); quote.className = 'reply-quote';
      const author = document.createElement('span'); author.className = 'reply-author';
      author.textContent = original ? senderName(original) : snapshot.selfId === message.reply.senderId ? '나' : '원문 작성자';
      const text = document.createElement('span'); text.textContent = message.reply.text;
      quote.append(author, text); quote.title = '원문 보기';
      quote.addEventListener('click', () => {
        const target = [...messages.querySelectorAll('article')].find(a => a.dataset.messageId === message.reply.id);
        if (target) { target.scrollIntoView({block: 'center'}); target.focus({preventScroll:true}); }
      }); article.append(quote);
    }
    article.dataset.messageId = message.id; article.tabIndex = -1;
    if (outgoing) {
      const row = document.createElement('div'); row.className = 'outgoing-row';
      row.append(meta, body); article.append(row);
    } else article.append(body);
    if (message.footer) { const footer = document.createElement('div'); footer.className = 'card-footer'; footer.textContent = message.footer; article.append(footer); }
    if (message.buttons?.length) {
      const actions = document.createElement('div'); actions.className = 'card-actions';
      for (const item of message.buttons) {
        const button = document.createElement('button'); button.className = 'card-action'; button.textContent = item.label;
        button.disabled = !item.url; button.title = item.url || '지원하지 않는 동작';
        button.addEventListener('click', () => vscode.postMessage({type:'openButton',roomId:message.roomId,messageId:message.id,buttonId:item.id}));
        actions.append(button);
      } article.append(actions);
    }
    if (message.source === 'client' && /^[1-9][0-9]{0,19}$/.test(message.id)) {
      const reply = document.createElement('button'); reply.className = 'message-reply';
      reply.textContent = '답장'; reply.title = '이 메시지에 댓글·답장 작성'; reply.setAttribute('aria-label', `${senderName(message)}의 메시지에 답장`);
      reply.disabled = !snapshot.canSend || message.roomId !== snapshot.activeRoomId || Boolean(pendingSend);
      reply.addEventListener('click', () => {
        replyTargets.set(selectedRoom, {id:message.id, sender:senderName(message), text:message.text});
        sendError = ''; renderComposer(); byId('draft').focus({preventScroll:true});
      }); meta.insertBefore(reply, time);
    }
    return article;
  });
  const historyButton = document.createElement('button'); historyButton.className = 'history-load';
  historyButton.textContent = snapshot.history?.loading ? '이전 메시지 불러오는 중…' : snapshot.history?.limit ? '이 대화는 최대 1,000개까지 표시합니다.' :
    snapshot.history?.error || (snapshot.history?.empty ? '더 불러온 메시지가 없습니다 · 다시 확인' : '이전 메시지');
  historyButton.disabled = Boolean(!visible.length || snapshot.history?.loading || snapshot.history?.limit || snapshot.busy || snapshot.sending);
  historyButton.addEventListener('click', () => loadHistory(true));
  messages.replaceChildren(historyButton, ...elements);
  if (activePreview) {
    const anchor = [...messages.querySelectorAll('.image-label')].find(label => label.dataset.imageId === activePreview.messageId && selectedRoom === JSON.stringify(['client', activePreview.roomId]));
    if (anchor) { activePreview.anchor = anchor; positionImagePreview(); } else hideImagePreview();
  }
  const prepended = oldFirst && visible[0]?.id && BigInt(visible[0].id) < BigInt(oldFirst);
  const nextAnchor = anchorId && [...messages.querySelectorAll('article')].find(item => item.dataset.messageId === anchorId);
  if (!forceScroll && sameRoom && nextAnchor && (prepended || !atBottom)) messages.scrollTop += nextAnchor.getBoundingClientRect().top - top - anchorOffset;
  else messages.scrollTop = forceScroll || !sameRoom || atBottom ? messages.scrollHeight : previousTop;
  renderedRoom = selectedRoom; previousScrollTop = messages.scrollTop;
}

function render(forceScroll = false) {
  const active = rooms.find(room => room.key === selectedRoom);
  const conversation = !snapshot.roomPicker?.open && screen === 'conversation' && Boolean(active);
  if (!conversation) hideImagePreview();
  byId('home').hidden = conversation;
  messages.hidden = !conversation;
  byId('back').hidden = !conversation;
  byId('panel-title').textContent = conversation ? active.title : 'Chats';
  byId('panel-title').title = conversation ? active.title : '채팅방 목록';
  byId('selected-room').textContent = active?.title || 'Local Chat';
  renderRooms();
  if (conversation) renderMessages(forceScroll);
  renderComposer();
  const visible = conversation && active?.source === 'client' ? active.id : '';
  if (visible !== visibleKey) { visibleKey = visible; vscode.postMessage({type:'visibleRoom', roomId:visible}); }
}

for (const type of ['disconnect', 'settings', 'logs', 'toggleSending']) {
  byId(type).addEventListener('click', () => { closeMenu(true); vscode.postMessage({type}); });
}
byId('refresh-rooms').addEventListener('click', () => vscode.postMessage({type: 'rooms'}));
byId('room-search').addEventListener('input', renderRooms);
byId('back').addEventListener('click', showHome);
byId('composer-menu').addEventListener('click', toggleMenu);
byId('draft').addEventListener('input', () => { sendError = ''; drafts.set(selectedRoom, byId('draft').value); renderComposer(); });
byId('draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submitDraft(); }
});
byId('send').addEventListener('click', submitDraft);
byId('send').addEventListener('mousedown', event => event.preventDefault());
byId('cancel-reply').addEventListener('click', () => { replyTargets.delete(selectedRoom); renderComposer(); byId('draft').focus({preventScroll:true}); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(true); hideImagePreview(); } });
document.addEventListener('click', event => {
  if (!event.target.closest('.popup, #composer-menu')) closeMenu();
});

window.addEventListener('message', event => {
  if (event.data?.type === 'image-preview-result') {
    if (!activePreview || activePreview.requestId !== event.data.requestId) return;
    const image = event.data.image;
    if (image && ['image/jpeg', 'image/png'].includes(image.mime) && typeof image.data === 'string' && image.data.length <= 1398104 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      imagePreviews.set(activePreview.key, image);
      while (imagePreviews.size > 8) imagePreviews.delete(imagePreviews.keys().next().value);
      showPreviewImage(image);
    } else {
      byId('image-preview-status').textContent = '미리보기를 불러올 수 없습니다.';
      positionImagePreview();
    }
    return;
  }
  if (event.data?.type === 'openRoom') {
    const key = JSON.stringify(['client', event.data.roomId]);
    if (rooms.some(room => room.key === key)) { selectedRoom = key; screen = 'conversation'; persist(); render(true); }
    return;
  }
  if (event.data?.type === 'send-result' && pendingSend?.requestId === event.data.requestId) {
    if (event.data.ok && drafts.get(pendingSend.key) === pendingSend.text) drafts.delete(pendingSend.key);
    if (event.data.ok && replyTargets.get(pendingSend.key)?.id === pendingSend.replyTo) replyTargets.delete(pendingSend.key);
    sendError = event.data.ok ? '' : event.data.error || 'PC카톡에서 전송 상태를 확인하세요.';
    pendingSend = undefined;
    renderComposer();
    return;
  }
  if (event.data?.type !== 'state') return;
  const openingPicker = event.data.roomPicker?.open && !snapshot.roomPicker?.open;
  snapshot = event.data;
  historyRequested = Boolean(snapshot.history?.loading);
  if (snapshot.mode !== 'live' || snapshot.busy || snapshot.roomPicker?.open) { hideImagePreview(); imagePreviews.clear(); }
  if (openingPicker) { byId('room-search').value = ''; closeMenu(); screen = 'home'; }
  const grouped = new Map();
  for (const message of snapshot.messages) {
    const key = roomKey(message);
    const prior = grouped.get(key);
    if (!prior || Date.parse(message.timestamp) >= Date.parse(prior.timestamp)) {
      grouped.set(key, {key, id: message.roomId, source: message.source, title: message.roomTitle, timestamp: message.timestamp});
    }
  }
  const available = new Set((snapshot.roomPicker?.rooms || []).map(room => room.id));
  for (const [key, room] of grouped) if (room.source !== 'client' || (!available.has(room.id) && (room.id !== snapshot.activeRoomId || snapshot.roomPicker?.open))) grouped.delete(key);
  for (const room of snapshot.roomPicker?.rooms || []) {
    const key = JSON.stringify(['client', room.id]);
    grouped.set(key, {...grouped.get(key), key, id: room.id, source: 'client', title: room.title,
      unreadCount: room.unreadCount || 0, ...(room.lastMessageAt ? {timestamp: room.lastMessageAt} : {})});
  }
  if (snapshot.mode === 'live' && snapshot.activeRoomId && !snapshot.roomPicker?.open) {
    const key = JSON.stringify(['client', snapshot.activeRoomId]);
    if (!grouped.has(key)) grouped.set(key, {key, id: snapshot.activeRoomId, source: 'client', title: snapshot.activeRoomTitle || '대화'});
  }
  rooms = [...grouped.values()].sort((a, b) => (snapshot.roomSort === 'unread' ? Number(Boolean(b.unreadCount)) - Number(Boolean(a.unreadCount)) : 0) || (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  if (snapshot.activeRoomId !== lastActiveRoomId) { pendingRoomId = snapshot.activeRoomId || ''; lastActiveRoomId = snapshot.activeRoomId; sendError = ''; }
  const pendingKey = JSON.stringify(['client', pendingRoomId]);
  if (pendingRoomId && grouped.has(pendingKey) && !snapshot.roomPicker?.open) {
    selectedRoom = pendingKey; screen = 'conversation'; pendingRoomId = ''; persist();
  }
  if (selectedRoom && !grouped.has(selectedRoom)) { selectedRoom = ''; screen = 'home'; persist(); }
  if (snapshot.mode === 'idle' && !snapshot.activeRoomId) { screen = 'home'; persist(); }
  byId('disconnect').disabled = Boolean(snapshot.sending || (snapshot.mode === 'idle' && !snapshot.messages.length));
  render();
  if (openingPicker) byId('room-search').focus();
});

vscode.postMessage({type: 'ready'});
