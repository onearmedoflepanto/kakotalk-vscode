'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {ReceiverService} = require('../src/receiver-service.cjs');
const {ReceiverClient} = require('../src/receiver-client.cjs');
const {JsonLines} = require('../src/json-lines.cjs');
const {validateMessage, httpUrl} = require('../src/protocol.cjs');
const room = (id = '1', latest = '100', unread = 1, sender = '20') => ({id, title: '테스트 '+id, lastMessageId: latest, unreadCount: unread, lastSenderId: sender, lastMessageAt: '2026-11-17T00:00:00Z'});
const snapshot = (rooms, session = 'process1') => ({pid: 7, session, rooms});
function fixture(t) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const collector = new EventEmitter(); collector.stop = async () => ({clean: true}); collector.dispose = async () => {};
  const monitor = {stop: async () => {}, snapshot: async () => snapshot([])};
  const service = new ReceiverService('.', {collector, monitor});
  const notices = []; service.on('notification', n => notices.push(n));
  t.after(() => service.dispose()); return {service, notices, monitor, collector};
}
test('receiver baselines history and new rooms, suppresses repeated/older IDs, and batches new arrivals', t => {
  const {service, notices} = fixture(t);
  service.observe(snapshot([room()])); t.mock.timers.tick(10000); assert.equal(notices.length,0);
  service.observe(snapshot([room('1','101',2)]));
  service.observe(snapshot([room('1','102',3),room('2')]));
  service.observe(snapshot([room('1','102',3),room('2')])); t.mock.timers.tick(10000);
  assert.equal(notices.length,1); assert.equal(notices[0].rooms.length,1); assert.equal(notices[0].rooms[0].count,2);
  service.observe(snapshot([room('1','101',3)])); t.mock.timers.tick(10000); assert.equal(notices.length,1);
  service.observe(snapshot([room('1','102',3)])); t.mock.timers.tick(10000); assert.equal(notices.length,1,'A stale snapshot cannot reset the notification watermark');
});
test('own messages, read rooms, process restarts and disconnected gaps do not replay alerts', async t => {
  const {service, notices, monitor} = fixture(t);
  service.observe({...snapshot([room()]),selfId:'20'}); service.observe({...snapshot([room('1','101',2)]),selfId:'20'}); t.mock.timers.tick(10000); assert.equal(notices.length,0);
  service.observe(snapshot([room('1','102',0,'30')])); t.mock.timers.tick(10000); assert.equal(notices.length,0);
  service.observe(snapshot([room('1','103',1,'30')], 'process2')); t.mock.timers.tick(10000); assert.equal(notices.length,0);
  monitor.snapshot=async()=>{throw new Error('offline');}; await assert.rejects(service.refresh());
  service.observe(snapshot([room('1','110',9,'30')], 'process2')); t.mock.timers.tick(10000); assert.equal(notices.length,0);
});
test('read-before-toast removes a queued alert and stop clears state', async t => {
  const {service,notices}=fixture(t);
  service.observe(snapshot([room()]));service.observe(snapshot([room('1','101',2)]));service.observe(snapshot([room('1','101',0)]));
  t.mock.timers.tick(10000);assert.equal(notices.length,0);
  service.observe(snapshot([room('1','102',1)]));await service.stop();t.mock.timers.tick(10000);
  assert.equal(notices.length,0);assert.equal(service.notices.size,0);assert.equal(service.running,false);
});
test('each room waits ten quiet seconds and repeated snapshots do not delay its notification', t => {
  const {service,notices}=fixture(t);
  service.observe(snapshot([room('1'),room('2')]));
  service.observe(snapshot([room('1','101',2),room('2','101',2)]));
  t.mock.timers.tick(9000);assert.equal(notices.length,0);
  service.observe(snapshot([room('1','102',3),room('2','101',2)]));
  t.mock.timers.tick(999);assert.equal(notices.length,0);
  t.mock.timers.tick(1);assert.deepEqual(notices.map(n=>n.rooms[0].roomId),['2']);
  service.observe(snapshot([room('1','102',3),room('2','101',2)]));
  t.mock.timers.tick(8999);assert.equal(notices.length,1);
  t.mock.timers.tick(1);assert.equal(notices.length,2);
  assert.equal(notices[1].rooms[0].roomId,'1');assert.equal(notices[1].rooms[0].count,2);
  assert.equal(notices[1].rooms[0].lastMessageId,'102');assert.equal('timer' in notices[1].rooms[0],false);
  t.mock.timers.tick(30000);assert.equal(notices.length,2);
});
test('missing rooms, process changes and monitor errors cancel pending notifications', async t => {
  const {service,notices,monitor}=fixture(t);
  service.observe(snapshot([room()]));service.observe(snapshot([room('1','101',2)]));
  service.observe(snapshot([]));t.mock.timers.tick(10000);assert.equal(notices.length,0);
  service.observe(snapshot([room()]));service.observe(snapshot([room('1','102',3)]));
  service.observe(snapshot([room('1','102',3)],'process2'));t.mock.timers.tick(10000);assert.equal(notices.length,0);
  service.observe(snapshot([room('1','103',4)],'process2'));
  monitor.snapshot=async()=>{throw new Error('offline');};await assert.rejects(service.refresh());
  t.mock.timers.tick(10000);assert.equal(notices.length,0);assert.equal(service.notices.size,0);
});
test('rich contract preserves exact reply IDs and blocks non-web action URLs', () => {
  const base={version:1,type:'message',source:'client',id:'1',roomId:'2',roomTitle:'방',sender:'이름',text:'본문',timestamp:'2026-11-17T00:00:00Z'};
  const msg=validateMessage({...base,kind:'reply',reply:{id:'9000000000000002001',senderId:'90000002',text:'원문'},buttons:[{label:'열기',url:'command:workbench.action.quit'},{label:'웹',url:'https://example.com'}]});
  assert.equal(msg.reply.id,'9000000000000002001');assert.equal(msg.buttons[0].url,undefined);assert.equal(msg.buttons[1].url,'https://example.com/');
  assert.equal(httpUrl('https://user:secret@example.com'),undefined);assert.equal(httpUrl('javascript:alert(1)'),undefined);
  assert.throws(()=>validateMessage({...base,kind:'reply',reply:{id:'x',senderId:'1',text:'x'}}));
});
test('self identity follows native snapshots and clears on unavailable or changed sessions', async t => {
  const {service}=fixture(t),identities=[];service.on('identity',value=>identities.push(value.selfId));
  service.observe({...snapshot([room()]),selfId:'20'});assert.equal(service.selfId,'20');
  service.observe({...snapshot([room()]),selfId:'20'});assert.deepEqual(identities,['20']);
  service.observe({...snapshot([room()],'process2'),selfId:'30'});assert.equal(service.selfId,'30');
  service.observe(snapshot([room()],'process2'));assert.equal(service.selfId,'');
  service.observe({...snapshot([room()],'process2'),selfId:'18446744073709551616'});assert.equal(service.selfId,'');
  service.observe({...snapshot([room()],'process2'),selfId:'30'});await service.stop();assert.equal(service.selfId,'');
  assert.deepEqual(identities,['20','30','','30','']);
});
test('JSON IPC handles fragmented multibyte frames and rejects incomplete/oversized frames', () => {
  const values=[], decoder=new JsonLines(v=>values.push(v),64), bytes=Buffer.from('{"text":"한글"}\n');
  for(const b of bytes)decoder.push(Buffer.from([b]));decoder.finish();assert.equal(values[0].text,'한글');
  assert.throws(()=>new JsonLines(()=>{},2).push(Buffer.from('xxxx')));
  const incomplete=new JsonLines(()=>{});incomplete.push(Buffer.from('{'));assert.throws(()=>incomplete.finish());
});
test('standalone receiver process answers IPC without VS Code or native access and exits on pipe close', async () => {
  const client=new ReceiverClient(path.resolve(__dirname,'..'));
  try { assert.deepEqual(await client.snapshot(),{rooms:[],messages:[],selfId:''}); }
  finally { await client.dispose(); }
  assert.equal(client.child,undefined);
});
test('image preview requires a stored photo and binds native reads to the observed process and sender', async t => {
  const {service, monitor, collector} = fixture(t);
  service.running = true; service.observe(snapshot([room()]));
  let called;
  monitor.imagePreview = async value => { called = value; return {mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPioAAAAASUVORK5CYII='}; };
  await assert.rejects(service.imagePreview({roomId:'1',messageId:'9'})); assert.equal(called,undefined);
  collector.emit('message',{version:1,type:'message',source:'client',kind:'image',id:'9',roomId:'1',roomTitle:'방',sender:'이름',senderId:'20',text:'이미지',timestamp:'2026-11-17T00:00:00Z'});
  assert.equal((await service.imagePreview({roomId:'1',messageId:'9'})).width,1);
  assert.deepEqual(called,{pid:7,session:'process1',roomId:'1',messageId:'9',senderId:'20'});
  const good = monitor.imagePreview;
  monitor.imagePreview = async value => { const result = await good(value); service.observe(snapshot([room()],'process2')); return result; };
  await assert.rejects(service.imagePreview({roomId:'1',messageId:'9'}),/session changed/);
});
