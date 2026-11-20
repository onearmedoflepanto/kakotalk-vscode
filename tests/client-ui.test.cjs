'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validateSend, parseSendResult} = require('../src/client-ui.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const sample = () => ({pid: 123, roomId: '90000000000001', roomTitle: '테스트', text: '한글 👋\n다음 줄'});

test('send request preserves Unicode and routing identity without accepting arbitrary fields', () => {
  assert.deepEqual(validateSend({...sample(), command: 'ignored'}), sample());
});
test('send request rejects missing identity, empty input and oversized text before native execution', () => {
  for (const patch of [{pid: 0}, {pid: '123'}, {roomId: '*'}, {roomTitle: ''}, {text: ' '}, {text: 'a\0b'}, {text: 'a'.repeat(2001)}]) {
    assert.throws(() => validateSend({...sample(), ...patch}));
  }
});
test('reply submission preserves exact reference IDs and rejects ambiguous targets or overlong replies',()=>{
  const replyTo={id:'9000000000000002001',senderId:'90000002'};
  assert.deepEqual(validateSend({...sample(),replyTo:{...replyTo,command:'ignored'}}).replyTo,replyTo);
  for(const patch of [null,{},'1',{...replyTo,id:9000000000000002001},{...replyTo,id:'18446744073709551616'}])assert.throws(()=>validateSend({...sample(),replyTo:patch}));
  assert.throws(()=>validateSend({...sample(),replyTo,text:'a'.repeat(501)}));
});

test('draft conflict exposes Korean guidance without the PowerShell invocation wrapper', () => {
  assert.throws(() => parseSendResult(JSON.stringify({status: 'error', code: 'DRAFT_EXISTS', message: 'Exception calling Submit: private input'}), 1), error => {
    assert.equal(error.code, 'DRAFT_EXISTS');
    assert.match(error.message, /작성 중인 내용/);
    assert.doesNotMatch(error.message, /Submit|private input|Exception/);
    return true;
  });
});
test('send result requires success status, clean exit and cleared input', () => {
  assert.equal(parseSendResult('\uFEFF{"status":"submitted","inputCleared":true}', 0).status, 'submitted');
  for (const [data, code] of [['{', 0], ['null', 0], ['{"status":"submitted","inputCleared":false}', 0], ['{"status":"submitted","inputCleared":true}', 1]]) {
    assert.throws(() => parseSendResult(data, code));
  }
  assert.throws(() => parseSendResult('{"status":"error","code":"__proto__","message":"private"}', 1), error => error.code === 'CLIENT_ERROR' && !error.message.includes('private'));
});

function createHost(t) {
  const commands = new Map(), replies = [], nativeCalls = [], connections = [], notifications = [], opened = [];
  const settings = {enableSending: false};
  let notificationAction;
  let provider, receive, nativeFailure, connectFailure, configurationChanged, collectorInstance;
  const senderLifecycle = {warms: 0, stops: 0};
  let discover = async () => [{id: '123', title: '테스트'}, {id: '456', title: '테스트'}];
  let stops = 0, discoveries = 0;
  const disposable = () => ({dispose() {}});
  class Collector extends EventEmitter {
    constructor() { super(); collectorInstance = this; }
    async discover() { discoveries++; return discover(); }
    async connect(request) {
      connections.push(request);
      if (connectFailure) throw connectFailure;
      this.emit('status', '로컬 수신 연결됨');
      this.emit('ready', {pid: 42, roomTitle: '테스트', snapshotState: 'captured'}); return true;
    }
    async stop() { stops++; }
    async dispose() { this.removeAllListeners(); }
  }
  class Sender {
    async warm() { senderLifecycle.warms++; }
    async stop() { senderLifecycle.stops++; }
    async send(request) { nativeCalls.push(request); if (nativeFailure) throw nativeFailure; return {status: 'submitted'}; }
  }
  const vscode = {
    ConfigurationTarget: {Global: 1}, ProgressLocation: {Notification: 1},
    Uri: {joinPath: (_base, ...parts) => parts.join('/'), parse: value => value},
    env: {openExternal: async value => { opened.push(value); return true; }},
    workspace: {getConfiguration: () => ({get: (key, fallback) => settings[key] ?? fallback, update: async (key, value) => { settings[key] = value; }}), onDidChangeConfiguration: fn => { configurationChanged = fn; return disposable(); }},
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); },
      executeCommand: async (id, ...args) => commands.get(id)?.(...args)
    },
    window: {
      state: {focused:true},
      showInformationMessage: async (...args) => { notifications.push(args); return notificationAction; },
      createOutputChannel: () => ({appendLine() {}, show() {}, dispose() {}}),
      registerWebviewViewProvider: (_id, value) => { provider = value; return disposable(); },
      withProgress: (_options, fn) => fn({report() {}}),
      showQuickPick: () => { throw new Error('Room selection must stay in Chats'); }, showErrorMessage: async () => undefined
    }
  };
  const sandbox = {module: {exports: {}}, process: {platform: 'win32'}, setTimeout, clearTimeout,
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './receiver-client.cjs') return {ReceiverClient: Collector};
      if (name === './runtime.cjs') return {resolveWorker: async () => 'fixture-worker'};
      if (name === './client-ui.cjs') return {validateSend, ClientSender: Sender};
      return name.startsWith('./') ? require(path.join(__dirname, '../src', name)) : require(name);
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.cjs'), 'utf8'), sandbox);
  sandbox.module.exports.activate({extensionUri: {fsPath: 'fixture'}, globalStorageUri: {fsPath: 'fixture-storage'}, subscriptions: []});
  t.after(() => sandbox.module.exports.deactivate());
  const view = {visible:true,webview: {asWebviewUri: String, cspSource: 'fixture', postMessage: value => replies.push(value), onDidReceiveMessage: fn => { receive = fn; return disposable(); }}, onDidDispose() {}};
  provider.resolveWebviewView(view);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {commands, replies, nativeCalls, connections, settings, settle, senderLifecycle, notifications,opened,view,collector:collectorInstance, notifySettings: () => configurationChanged({affectsConfiguration: () => true}), receive: message => receive(message),
    state: () => replies.filter(value => value.type === 'state').at(-1), stopCount: () => stops, discoveryCount: () => discoveries,
    setNotificationAction: value=>{notificationAction=value;}, setDiscovery: fn => { discover = fn; }, setNativeFailure: error => { nativeFailure = error; }, setConnectFailure: error => { connectFailure = error; }};
}

test('one palette command opens Chats and selecting a room connects it without another action', async t => {
  const host = createHost(t);
  assert.deepEqual([...host.commands.keys()], ['localChat.open']);
  const manifest = require('../package.json');
  assert.deepEqual(manifest.contributes.commands, [{command: 'localChat.open', title: '카카오톡: 창 열기'}]);
  assert.equal('localChat.selfId' in manifest.contributes.configuration.properties,false);
  await host.commands.get('localChat.open')();
  assert.equal(host.connections.length, 0);
  assert.equal(host.state().roomPicker.open, true);
  assert.equal(host.state().roomPicker.rooms.length, 2);
  host.receive({type: 'selectRoom', roomId: '999'}); await host.settle();
  assert.equal(host.connections.length, 0, 'A webview cannot invent a destination');
  host.receive({type: 'selectRoom', roomId: '456', title: 'untrusted title'}); await host.settle();
  assert.equal(host.connections[0].roomId, '456', 'Duplicate room names are routed by ID');
  assert.equal(host.state().activeRoomTitle, '테스트');
  assert.equal(host.state().roomPicker.open, false);
  assert.equal(host.state().messages.length, 0, 'A connection does not require a cached message');
  const stops = host.stopCount();
  await host.commands.get('localChat.open')();
  assert.equal(host.stopCount(), stops, 'Browsing does not disconnect the active collector');
  assert.equal(host.state().activeRoomId, '456');
  host.receive({type: 'selectRoom', roomId: '456'});
  assert.equal(host.state().roomPicker.open, false);
  assert.equal(host.state().status, '로컬 수신 연결됨');
  assert.equal(host.connections.length, 1, 'Selecting the active room keeps its connection');
  host.receive({type: 'selectRoom', roomId: '123'}); await host.settle();
  assert.equal(host.connections[1].roomId, '123', 'The composer selector also switches the connection');
});
test('host validates the visible history cursor, coalesces requests and keeps live arrivals in the expanded range',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();host.receive({type:'selectRoom',roomId:'123'});await host.settle();
  const record=id=>({version:1,type:'message',source:'client',id:String(id),roomId:'123',roomTitle:'테스트',sender:'사용자',senderId:'20',text:'본문',timestamp:new Date().toISOString(),observation:'cache-snapshot'});
  for(let id=11;id<=30;id++)host.collector.emit('message',record(id));
  let calls=0,release;host.collector.history=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  host.receive({type:'history',roomId:'456',before:'21'});host.receive({type:'history',roomId:'123',before:'1'});await host.settle();assert.equal(calls,0);
  host.receive({type:'history',roomId:'123',before:'21'});host.receive({type:'history',roomId:'123',before:'21'});await host.settle();assert.equal(calls,1);assert.equal(host.state().history.loading,true);
  release({messages:Array.from({length:10},(_,n)=>record(n+11))});await host.settle();assert.equal(host.state().history.floor,'11');assert.equal(host.state().history.loading,false);
  host.collector.emit('message',{...record(31),observation:'ui-model-setter'});host.receive({type:'ready'});assert.equal(host.state().history.floor,'11');
});
test('room changes discard an in-flight history response',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();host.receive({type:'selectRoom',roomId:'123'});await host.settle();
  const record={version:1,type:'message',source:'client',id:'30',roomId:'123',roomTitle:'테스트',sender:'사용자',senderId:'20',text:'본문',timestamp:new Date().toISOString()};host.collector.emit('message',record);
  let release;host.collector.history=()=>new Promise(resolve=>{release=resolve;});host.receive({type:'history',roomId:'123',before:'30'});await host.settle();
  host.receive({type:'selectRoom',roomId:'456'});await host.settle();release({messages:[{...record,id:'20'}]});await host.settle();
  assert.equal(host.state().activeRoomId,'456');assert.equal(host.state().history.floor,'');assert.equal(host.state().messages.some(m=>m.id==='20'),false);
});

test('reply requests resolve the original from the host store and reject invented or foreign-room IDs',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();host.receive({type:'selectRoom',roomId:'123'});await host.settle();host.settings.enableSending=true;
  const original={version:1,type:'message',source:'client',id:'9000000000000002001',roomId:'123',roomTitle:'테스트',senderId:'90000002',sender:'나',text:'원문',timestamp:new Date().toISOString()};
  host.collector.emit('message',original);
  const request={type:'send',requestId:'reply-1',source:'client',roomId:'123',text:'답장',replyTo:'999'};
  host.receive(request);await host.settle();assert.equal(host.nativeCalls.length,0);
  host.receive({...request,replyTo:original.id});await host.settle();assert.deepEqual(host.nativeCalls[0].replyTo,{id:original.id,senderId:original.senderId});
});

test('notifications suppress the visible room, respect configuration and open a selected room',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();
  host.receive({type:'visibleRoom',roomId:'123'});
  const emit=rooms=>host.collector.emit('notification',{rooms});
  emit([{roomId:'123',roomTitle:'테스트',count:1}]);await host.settle();assert.equal(host.notifications.length,0);
  host.view.visible=false;emit([{roomId:'123',roomTitle:'테스트',count:2}]);await host.settle();assert.match(host.notifications[0][0],/2개/);
  host.settings.notifications=false;emit([{roomId:'456',roomTitle:'테스트',count:1}]);await host.settle();assert.equal(host.notifications.length,1);
  host.settings.notifications=true;host.setNotificationAction('채팅 열기');emit([{roomId:'456',roomTitle:'테스트',count:1}]);await host.settle();await host.settle();
  assert.equal(host.connections.at(-1).roomId,'456');assert.ok(host.replies.some(r=>r.type==='openRoom'&&r.roomId==='456'));
});
test('host uses the client identity without editable identity settings',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();
  host.collector.emit('identity',{selfId:'20'});host.receive({type:'ready'});assert.equal(host.state().selfId,'20');
  host.collector.emit('identity',{selfId:''});host.receive({type:'ready'});assert.equal(host.state().selfId,'');
});

test('card actions use stored web URLs and reject forged URLs and identifiers',async t=>{
  const host=createHost(t);await host.commands.get('localChat.open')();host.receive({type:'selectRoom',roomId:'123'});await host.settle();
  host.collector.emit('message',{version:1,type:'message',source:'client',kind:'card',id:'1',roomId:'123',roomTitle:'테스트',senderId:'2',sender:'발신자',text:'안내',timestamp:new Date().toISOString(),buttons:[{id:'0',label:'열기',url:'https://example.com/info'}]});
  host.receive({type:'openButton',roomId:'123',messageId:'1',buttonId:'0',url:'command:evil'});await host.settle();assert.deepEqual(host.opened,['https://example.com/info']);
  for(const patch of [{roomId:'456'},{messageId:'2'},{buttonId:'missing'}])host.receive({type:'openButton',roomId:'123',messageId:'1',buttonId:'0',...patch});
  await host.settle();assert.equal(host.opened.length,1);
});

test('opening the sidebar directly discovers rooms and repeated ready events do not restart discovery', async t => {
  const host = createHost(t);
  host.receive({type: 'ready'}); await host.settle();
  assert.equal(host.discoveryCount(), 1);
  assert.equal(host.state().roomPicker.rooms.length, 2);
  host.receive({type: 'ready'}); await host.settle();
  assert.equal(host.discoveryCount(), 1);
});

test('Chats handles loading, empty lists, discovery failures, stale results and connection retries', async t => {
  const host = createHost(t);
  let finish;
  host.setDiscovery(() => new Promise(resolve => { finish = resolve; }));
  const pending = host.commands.get('localChat.open')(); await host.settle();
  assert.equal(host.state().roomPicker.loading, true);
  host.receive({type: 'disconnect'}); await host.settle();
  finish([{id: '123', title: 'stale'}]); await pending;
  assert.equal(host.state().roomPicker.open, false);
  assert.equal(host.state().roomPicker.rooms.length, 0);
  host.setDiscovery(async () => []);
  await host.commands.get('localChat.open')();
  assert.equal(host.state().roomPicker.loading, false);
  assert.equal(host.state().roomPicker.rooms.length, 0);
  host.setDiscovery(async () => { throw new Error('목록 조회 실패'); });
  await host.commands.get('localChat.open')();
  assert.equal(host.state().roomPicker.error, '목록 조회 실패');
  host.setDiscovery(async () => [{id: '123', title: '테스트'}]);
  await host.commands.get('localChat.open')();
  host.setConnectFailure(new Error('수집기 시작 실패'));
  host.receive({type: 'selectRoom', roomId: '123'}); await host.settle();
  assert.equal(host.state().roomPicker.open, true);
  assert.equal(host.state().roomPicker.error, '수집기 시작 실패');
  assert.equal(host.state().busy, false);
  host.setConnectFailure(undefined);
  host.receive({type: 'selectRoom', roomId: '123'}); await host.settle();
  assert.equal(host.state().roomPicker.open, false);
  assert.equal(host.state().status, '로컬 수신 연결됨');
});

test('extension host allows a send only for an enabled, connected client room', async t => {
  const host = createHost(t);
  const {commands, receive, settle, nativeCalls, settings, replies} = host;
  const request = {type: 'send', requestId: '1', source: 'client', roomId: '123', text: '요청 본문'};
  await commands.get('localChat.open')();
  receive({type: 'selectRoom', roomId: '123'}); await settle();
  receive(request); await settle();
  assert.equal(nativeCalls.length, 0, 'Sending is off by default');
  settings.enableSending = true;
  host.notifySettings(); await settle();
  assert.equal(host.senderLifecycle.warms, 1, 'Enabling replies prepares the helper before typing');
  receive({...request, roomId: '999'}); receive({...request, source: 'unknown'}); await settle();
  assert.equal(nativeCalls.length, 0, 'Wrong room and unknown source cannot send');
  receive(request); await settle();
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].pid, 42);
  assert.equal(nativeCalls[0].roomId, '123');
  assert.equal(nativeCalls[0].text, request.text);
  assert.ok(replies.some(value => value.type === 'send-result' && value.ok));
  let nativeFailure;
  try { parseSendResult('{"status":"error","code":"DRAFT_EXISTS"}', 1); }
  catch (error) { nativeFailure = error; host.setNativeFailure(error); }
  receive({...request, requestId: '2'}); await settle();
  assert.equal(nativeCalls.length, 2, 'Failed submission is not retried automatically');
  assert.equal(replies.find(value => value.type === 'send-result' && value.requestId === '2').error, nativeFailure.message);
  receive({type: 'disconnect'}); await settle();
  assert.ok(host.senderLifecycle.stops > 0, 'Leaving the client connection closes its helper');
  receive(request); await settle();
  assert.equal(nativeCalls.length, 2, 'A disconnected session cannot reuse the previous client destination');
});
