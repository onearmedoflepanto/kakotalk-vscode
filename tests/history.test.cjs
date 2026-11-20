'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {MessageStore} = require('../src/protocol.cjs');
const {ReceiverService} = require('../src/receiver-service.cjs');
const {CollectorClient} = require('../src/collector-client.cjs');
const path = require('node:path');
const message = (id, roomId = '1') => ({version:1,type:'message',source:'client',id:String(id),roomId,roomTitle:'방',senderId:'20',sender:'이름',text:'본문',timestamp:'2026-11-17T00:00:00Z'});
function fixture(t) {
  const collector = new EventEmitter(), calls = [];
  Object.assign(collector, {stop:async()=>({clean:true}), dispose:async()=>{}, history:async()=>[]});
  const monitor = {stop:async()=>{}, history:async request => {calls.push(request);return {...request,initialLogs:[],profiles:[],scrolled:request.scroll};}};
  const service = new ReceiverService('.', {collector,monitor});
  service.observe({pid:7,session:'7:100',rooms:[{id:'1',title:'방',unreadCount:0}]});
  service.running = true; service.activeRoomId = '1';
  t.after(()=>service.dispose());
  return {service,collector,monitor,calls};
}
test('history pages preserve 64-bit ordering and deduplicate overlapping snapshots', () => {
  const store = new MessageStore(1000,true), base = 3975687938727917500n;
  for (let n=29;n>=0;n--) store.add(message(base+BigInt(n)));
  assert.equal(store.add(message(base)),false);
  const latest=store.page('1'); assert.equal(latest.length,10); assert.equal(latest[0].id,String(base+20n));
  assert.deepEqual(store.page('1',latest[0].id).map(m=>m.id),Array.from({length:10},(_,n)=>String(base+10n+BigInt(n))));
});
test('per-room retention does not evict recent messages when old history arrives', () => {
  const store=new MessageStore(3,true);
  [102,101,100].forEach(id=>store.add(message(id)));store.add(message(1));store.add(message(1,'2'));
  assert.deepEqual(store.page('1').map(m=>m.id),['100','101','102']); assert.equal(store.page('2').length,1);
});
test('cached history needs no native control and never creates notifications', async t => {
  const {service,calls}=fixture(t), notices=[];service.on('notification', n=>notices.push(n));
  for(let n=1;n<=25;n++)service.store.add(message(n));
  const page=await service.history({roomId:'1',before:'16'});
  assert.deepEqual(page.messages.map(m=>m.id),Array.from({length:10},(_,n)=>String(n+6)));
  assert.equal(page.source,'cache');assert.equal(calls.length,0);assert.equal(notices.length,0);
});
test('history checks resident records before scrolling and stops after a useful page', async t => {
  const {service,collector,calls}=fixture(t);
  collector.history=async value=>value.scrolled ? [message(90),message(91)] : [];
  const result=await service.history({roomId:'1',before:'100'});
  assert.deepEqual(calls.map(c=>c.scroll),[false,true]);assert.equal(result.scrolled,true);assert.equal(result.messages.length,2);
});
test('no-progress history is bounded and remains retryable', async t => {
  const {service,calls}=fixture(t);
  assert.equal((await service.history({roomId:'1',before:'100'})).messages.length,0);
  assert.deepEqual(calls.map(c=>c.scroll),[false,true,true,true]);assert.equal(service.historyPending,false);
});
test('history rejects foreign rooms, invalid cursors and overlapping requests', async t => {
  const {service,monitor}=fixture(t);let release;
  await assert.rejects(service.history({roomId:'2',before:'100'}));
  await assert.rejects(service.history({roomId:'1',before:'18446744073709551616'}));
  monitor.history=()=>new Promise(resolve=>{release=resolve;});
  const pending=service.history({roomId:'1',before:'100'});
  await assert.rejects(service.history({roomId:'1',before:'100'}));
  service.connectEpoch++;release({});await assert.rejects(pending,/연결/);assert.equal(service.historyPending,false);
});
test('a stopped or changed client discards pending native results',async t=>{
  const {service,collector}=fixture(t);
  collector.history=async()=>{service.observe({pid:8,session:'8:200',rooms:[{id:'1',title:'방',unreadCount:0}]});return [message(90)];};
  await assert.rejects(service.history({roomId:'1',before:'100'}),/연결/);assert.equal(service.store.snapshot().length,0);
});
test('collector history IPC correlates pages, rejects foreign records and cancels on stop',async()=>{
  const client=new CollectorClient(path.resolve(__dirname,'..'));
  try {
    await client.launch({program:process.execPath,args:[path.join(__dirname,'fixtures/collector.cjs')],metadata:{roomId:'1'},duration:60});
    const page=await client.history({roomId:'1',before:'100'});assert.equal(page.length,1);assert.equal(page[0].text,'이전 본문');
    await assert.rejects(client.history({roomId:'1',before:'2'}),/Unexpected history/);
    const pending=client.history({roomId:'1',before:'3'});const rejected=assert.rejects(pending,/종료/);
    await assert.rejects(client.history({roomId:'1',before:'3'}),/불러오는 중/);
    await client.stop();await rejected;
  } finally {await client.dispose();}
});
