'use strict';

const vscode = require('vscode');
const {randomBytes} = require('node:crypto');
const {MessageStore, validateMessage, httpUrl} = require('./protocol.cjs');
const {ReceiverClient} = require('./receiver-client.cjs');
const {resolveWorker} = require('./runtime.cjs');
const {renderWebview} = require('./webview.cjs');
const {validateImagePreview} = require('./image-preview.cjs');
const {ClientSender, validateSend} = require('./client-ui.cjs');
let shutdown;

function activate(context) {
  const store = new MessageStore(1000, true);
  const collector = new ReceiverClient(context.extensionUri.fsPath);
  const sender = new ClientSender(context.extensionUri.fsPath);
  const output = vscode.window.createOutputChannel('Local Chat');
  let view, renderTimer, renewTimer, operation = 0;
  let status = '연결 안 됨', mode = 'idle', activeRoomId = '', warning = '';
  let busy = false, disposed = false, sendPending = false, activePid = 0, activeRoomTitle = '';
  let discovery = 0;
  let visibleRoomId = '';
  let imagePending = false;
  let history = {floor: '', loading: false, error: '', empty: false, limit: false};
  let selfId = '';
  let roomPicker = {open: false, loading: false, rooms: [], error: ''};
  const config = () => vscode.workspace.getConfiguration('localChat');
  const render = () => view?.webview.postMessage({type: 'state', status, mode, busy, sending: sendPending, warning, activeRoomId, activeRoomTitle, roomPicker,
    messages: store.snapshot(), history, selfId, sendingEnabled: config().get('enableSending', false), roomSort: config().get('roomSort', 'recent'),
    canSend: mode === 'live' && status === '로컬 수신 연결됨' && !busy && !sendPending && !roomPicker.open && config().get('enableSending', false)});
  const scheduleRender = () => {
    if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; render(); }, 50);
  };
  const log = text => output.appendLine(`${new Date().toISOString()} ${text}`);
  const prepareSender = () => {
    if (sendPending) return;
    if (!disposed && mode === 'live' && activePid && status === '로컬 수신 연결됨' && config().get('enableSending', false)) {
      void sender.warm().catch(error => log(`sender preparation failed: ${error.code || 'START_FAILED'}`));
    } else { void sender.stop(); }
  };
  const closeRoomPicker = () => {
    discovery++;
    roomPicker = {...roomPicker, open: false, loading: false, error: ''};
    render();
  };
  const discoverRooms = async () => {
    if (busy || disposed || sendPending || roomPicker.loading) return;
    const token = ++discovery;
    roomPicker = {open: true, loading: true, rooms: [], error: ''}; render();
    try {
      if (process.platform !== 'win32') throw new Error('로컬 수신 연결은 Windows에서 사용할 수 있습니다.');
      const rooms = await collector.discover();
      if (token !== discovery || disposed) return;
      roomPicker = {open: true, loading: false, rooms, error: ''};
    } catch (error) {
      if (token !== discovery || disposed) return;
      roomPicker = {open: true, loading: false, rooms: [], error: error.message};
      log(error.message);
    } finally { if (token === discovery && !disposed) render(); }
  };
  const disconnect = async (clear = true, keepPicker = false, connecting = false) => {
    if (sendPending && !disposed) return;
    if (!keepPicker) closeRoomPicker();
    const token = ++operation;
    history = {floor: '', loading: false, error: '', empty: false, limit: false};
    clearTimeout(renewTimer); activeRoomId = ''; activePid = 0; activeRoomTitle = ''; busy = connecting;
    mode = 'idle';
    await sender.stop();
    const result = await collector.stop({monitor: !connecting});
    if (token !== operation) return;
    if (clear) store.clear();
    warning = '';
    status = result && !result.clean ? '수집기 종료 상태를 로그에서 확인하세요.' : '연결 안 됨';
    render();
  };
  const connect = async (roomId, roomTitle = '', selected = false) => {
    if (busy || disposed || sendPending) return;
    if (process.platform !== 'win32') { vscode.window.showErrorMessage('로컬 수신 연결은 Windows에서 사용할 수 있습니다.'); return; }
    const stopping = disconnect(false, true, true);
    const token = operation;
    await stopping;
    if (token !== operation || disposed) return;
    busy = true; status = '수집기 환경 확인 중'; render();
    try {
      const workerPath = await resolveWorker({root: context.extensionUri.fsPath});
      if (token !== operation || disposed) return;
      mode = 'live'; activeRoomId = roomId; activeRoomTitle = roomTitle;
      await collector.connect({workerPath, roomId});
      if (token === operation && !disposed && selected) closeRoomPicker();
    } catch (error) {
      if (token !== operation || disposed) return;
      status = '연결 실패 · 로그를 확인하세요.'; mode = 'idle'; log(error.message);
      if (selected) { roomPicker = {...roomPicker, open: true, error: error.message}; return; }
      const action = await vscode.window.showErrorMessage(error.message, '로그 보기');
      if (action === '로그 보기') output.show(true);
    } finally { if (token === operation) { busy = false; render(); } }
  };
  const selectRoom = message => {
    if (roomPicker.loading || busy || sendPending) return;
    const room = roomPicker.rooms.find(value => value.id === message.roomId);
    if (!room) return;
    if (mode === 'live' && activeRoomId === room.id && status === '로컬 수신 연결됨') { closeRoomPicker(); return; }
    roomPicker = {...roomPicker, open: true, error: ''};
    void connect(room.id, room.title, true);
  };
  const previewImage = async (message, webview) => {
    if (typeof message.requestId !== 'string' || message.requestId.length > 80) return;
    const reply = value => webview.postMessage({type: 'image-preview-result', requestId: message.requestId, ...value});
    const item = store.snapshot().find(m => m.kind === 'image' && m.roomId === activeRoomId && m.roomId === message.roomId && m.id === message.messageId);
    if (!item || imagePending || disposed || busy || mode !== 'live' || roomPicker.open) { reply({error: '미리보기를 불러올 수 없습니다.'}); return; }
    const token = operation;
    imagePending = true;
    try {
      const image = validateImagePreview(await collector.imagePreview({roomId: item.roomId, messageId: item.id}));
      if (token === operation && !disposed && activeRoomId === item.roomId) reply({image});
    } catch (_) { reply({error: '미리보기를 불러올 수 없습니다.'}); }
    finally { imagePending = false; }
  };
  const toggleSending = () => config().update('enableSending', !config().get('enableSending', false), vscode.ConfigurationTarget.Global);
  const loadHistory = async message => {
    if (history.loading || history.limit || busy || disposed || sendPending || imagePending || roomPicker.open || mode !== 'live' ||
        status !== '로컬 수신 연결됨' || message.roomId !== activeRoomId) return;
    const current = store.page(activeRoomId, '', history.floor ? 1000 : 10).filter(item => !history.floor || BigInt(item.id) >= BigInt(history.floor));
    const before = current[0]?.id;
    if (!before || message.before !== before) return;
    const token = operation, roomId = activeRoomId;
    history = {...history, floor: before, loading: true, error: '', empty: false}; render();
    try {
      const result = await collector.history({roomId, before});
      if (token !== operation || disposed) return;
      if (!Array.isArray(result.messages) || result.messages.length > 10) throw new Error('과거 메시지 형식이 올바르지 않습니다.');
      const values = result.messages.map(validateMessage);
      if (values.some(item => item.source !== 'client' || item.roomId !== roomId || BigInt(item.id) >= BigInt(before))) throw new Error('과거 메시지 범위가 올바르지 않습니다.');
      for (const item of values) store.add(item);
      history = {...history, floor: values.reduce((id, item) => BigInt(item.id) < BigInt(id) ? item.id : id, before), empty: values.length === 0, limit: result.limit === true};
    } catch (error) {
      if (token === operation && !disposed) { history = {...history, error: '과거 메시지를 불러오지 못했습니다. 다시 시도해 주세요.'}; log(`history failed: ${error.message}`); }
    } finally { if (token === operation && !disposed) { history = {...history, loading: false}; render(); } }
  };
  const submit = async (message, webview) => {
    const reply = (ok, error = '') => webview.postMessage({type: 'send-result', requestId: message.requestId, ok, error});
    if (sendPending || history.loading || busy || roomPicker.open || mode !== 'live' || status !== '로컬 수신 연결됨' || !config().get('enableSending', false) ||
        message.source !== 'client' || message.roomId !== activeRoomId || typeof message.requestId !== 'string' || message.requestId.length > 80) {
      reply(false, '현재 연결된 채팅방에서 답장 기능을 켠 뒤 보내세요.'); return;
    }
    sendPending = true; render();
    const started = Date.now();
    try {
      let replyTo;
      if (message.replyTo !== undefined) {
        const original = store.snapshot().find(m => m.source === 'client' && m.roomId === activeRoomId && m.id === message.replyTo);
        if (!original) throw new Error('답장할 원문을 현재 대화에서 다시 선택하세요.');
        replyTo = {id: original.id, senderId: original.senderId};
      }
      const request = validateSend({pid: activePid, roomId: activeRoomId, roomTitle: activeRoomTitle, text: message.text, ...(replyTo ? {replyTo} : {})});
      const workerPath = replyTo ? await resolveWorker({root: context.extensionUri.fsPath}) : undefined;
      await sender.send(request, {workerPath});
      log(`send completed in ${Date.now() - started}ms`);
      reply(true);
    } catch (error) {
      log(`send failed: ${error.code || 'VALIDATION_ERROR'}`);
      reply(false, error.message);
      vscode.window.showErrorMessage(error.message);
    } finally {
      sendPending = false;
      if (mode !== 'live' || status !== '로컬 수신 연결됨' || !config().get('enableSending', false)) void sender.stop();
      render();
    }
  };
  collector.on('message', event => {
    if (!history.floor && event.roomId === activeRoomId && event.observation === 'ui-model-setter') {
      const page = store.page(activeRoomId);
      if (page.length && BigInt(event.id) > BigInt(page.at(-1).id)) history = {...history, floor: page[0].id};
    }
    if (!disposed && mode === 'live' && store.add(event)) {
      if (warning.startsWith('PC카톡에서')) warning = '';
      scheduleRender();
    }
  });
  collector.on('rooms', rooms => {
    if (disposed) return;
    roomPicker = {...roomPicker, rooms}; scheduleRender();
  });
  collector.on('identity', value => { if (!disposed) { selfId = value.selfId; scheduleRender(); } });
  collector.on('notification', async event => {
    if (disposed || !config().get('notifications', true)) return;
    const notices = (event.rooms || []).filter(item => roomPicker.rooms.some(room => room.id === item.roomId) &&
      !(view?.visible && vscode.window.state.focused && visibleRoomId === item.roomId));
    if (!notices.length) return;
    const notice = notices.length === 1 ? notices[0] : null;
    let text = notice ? `${notice.roomTitle} · 새 메시지 ${notice.count}개` : `${notices.length}개 채팅방에 새 메시지가 있습니다.`;
    if (notice && config().get('notificationPreview', false)) {
      const message = store.snapshot().find(m => m.source === 'client' && m.roomId === notice.roomId && m.id === notice.lastMessageId);
      if (message) text += ` · ${message.senderResolved === false || message.sender === message.senderId ? '알 수 없는 발신자' : message.sender}: ${message.text.replace(/\s+/g, ' ').slice(0, 100)}`;
    }
    const action = await vscode.window.showInformationMessage(text, '채팅 열기');
    if (action !== '채팅 열기' || disposed || sendPending || busy) return;
    await vscode.commands.executeCommand('localChat.messages.focus');
    if (notice && roomPicker.rooms.some(room => room.id === notice.roomId)) {
      await connect(notice.roomId, notice.roomTitle, true);
      view?.webview.postMessage({type: 'openRoom', roomId: notice.roomId});
    } else await discoverRooms();
  });
  collector.on('ready', value => {
    activePid = value.pid; activeRoomTitle = value.roomTitle;
    if (value.snapshotState !== 'captured') warning = 'PC카톡에서 선택한 채팅방을 열어 주세요. 화면에 표시되는 텍스트부터 수집합니다.';
    prepareSender();
    render();
  });
  collector.on('status', value => { if (mode === 'live' && !disposed) { status = value; render(); } });
  collector.on('diagnostic', value => {
    if (value.cleanup) log(`cleanup ${JSON.stringify(value.cleanup)}`);
    if (value.counters?.dropped) { warning = `수집 큐에서 ${value.counters.dropped}건 누락`; render(); }
    if (value.status === 'error') log(value.message || '수집기 오류');
  });
  collector.on('ended', result => {
    if (result.reason === 'receiver-exit') { selfId = ''; scheduleRender(); }
    if (!sendPending) void sender.stop();
    log(`collector ended ${JSON.stringify(result)}`);
    if (result.clean && result.reason === 'duration-ended' && mode === 'live' && activeRoomId && !disposed) {
      const room = activeRoomId, title = activeRoomTitle;
      renewTimer = setTimeout(() => connect(room, title), 1500);
    }
  });
  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const webview = view.webview;
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      webview.options = {enableScripts: true, localResourceRoots: [media]};
      webview.html = renderWebview({
        cssUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css')),
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')),
        cspSource: webview.cspSource, nonce: randomBytes(16).toString('hex')
      });
      const receiver = webview.onDidReceiveMessage(message => {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') {
          render();
          if (mode === 'idle' && !roomPicker.open) void discoverRooms();
        }
        if (message.type === 'rooms') void discoverRooms();
        if (message.type === 'selectRoom') selectRoom(message);
        if (message.type === 'disconnect') void disconnect();
        if (message.type === 'logs') output.show(true);
        if (message.type === 'toggleSending') void toggleSending();
        if (message.type === 'send') void submit(message, webview);
        if (message.type === 'history') void loadHistory(message);
        if (message.type === 'image-preview') void previewImage(message, webview);
        if (message.type === 'visibleRoom') visibleRoomId = typeof message.roomId === 'string' ? message.roomId : '';
        if (message.type === 'openButton') {
          const item = store.snapshot().find(m => m.source === 'client' && m.roomId === activeRoomId && m.roomId === message.roomId && m.id === message.messageId);
          const button = item?.buttons?.find(b => b.id === message.buttonId);
          const url = httpUrl(button?.url);
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        if (message.type === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-workspace.kakao-local-chat');
      });
      webviewView.onDidDispose(() => { receiver.dispose(); if (view === webviewView) { view = undefined; visibleRoomId = ''; } });
    }
  };
  const open = async () => { await vscode.commands.executeCommand('localChat.messages.focus'); await discoverRooms(); };
  shutdown = async () => { disposed = true; clearTimeout(renderTimer); clearTimeout(renewTimer); await disconnect(); await collector.dispose(); output.dispose(); };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localChat.messages', provider),
    vscode.commands.registerCommand('localChat.open', open),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('localChat')) {
      prepareSender(); render();
    } })
  );
}

async function deactivate() { await shutdown?.(); shutdown = undefined; }
module.exports = {activate, deactivate};
