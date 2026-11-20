'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {ClientSender} = require('../src/client-ui.cjs');
const path = require('node:path');
const request = {pid: 42, roomId: '123', roomTitle: '테스트', text: '한글 👋\n다음 줄'};
const inputTarget = {dialog:'0x100000',window:'0x200000',editor:'0x300000',processStartFileTime:'134077000000000000'};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, {ready = true, autoPrepare = true, ...timeouts} = {}) {
  const children = [];
  const sender = new ClientSender('fixture', {startupTimeoutMs: 1000, requestTimeoutMs: 1000, ...timeouts,
    spawnProcess: (program, args, options) => {
      assert.ok(args.includes('-Worker'));
      assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
      assert.ok(!args.includes(request.text));
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.requests = []; child.kills = 0;
      child.stdin.on('data', data => {
        const value=JSON.parse(data.toString('utf8')); child.requests.push(value);
        if(autoPrepare&&value.operation==='prepare')queueMicrotask(()=>child.respond({status:'prepared',roomId:value.roomId,inputTarget,requestId:value.requestId}));
      });
      child.kill = () => { child.kills++; queueMicrotask(() => child.emit('close', 1)); return true; };
      child.respond = value => child.stdout.write(JSON.stringify(value) + '\n');
      children.push(child);
      if (ready) queueMicrotask(() => {
        child.stdout.write('\uFEFF{"status":"rea');
        child.stdout.write('dy","protocolVersion":1}\r\n');
      });
      return child;
    }});
  t.after(() => sender.stop());
  return {sender, children};
}

test('sender warms once, preserves Unicode frames and reuses the worker across sequential messages', async t => {
  const {sender, children} = fixture(t);
  await Promise.all([sender.warm(), sender.warm()]);
  assert.equal(children.length, 1); assert.equal(children[0].requests.length, 0, 'Warmup never sends');
  for (let i = 1; i <= 2; i++) {
    const pending = sender.send(request); await tick();
    assert.deepEqual(children[0].requests[i - 1], {...request, requestId: String(i)});
    children[0].respond({status: 'submitted', inputCleared: true, requestId: String(i)});
    assert.equal((await pending).status, 'submitted');
  }
  assert.equal(children.length, 1);
  assert.equal(children[0].stdin.writableEnded, false);
  await sender.stop();
  assert.equal(children[0].kills, 1);
});

test('sender permits only one in-flight request and never resends a failed draft', async t => {
  const {sender, children} = fixture(t);
  const pending = sender.send(request);
  await assert.rejects(sender.send(request), error => error.code === 'BUSY');
  await tick();
  const rejected = assert.rejects(pending, error => error.code === 'DRAFT_EXISTS');
  children[0].respond({status: 'error', code: 'DRAFT_EXISTS', requestId: '1'});
  await rejected; await tick();
  assert.equal(children[0].requests.length, 1); assert.equal(children.length, 1);
  const next = sender.send(request); await tick();
  children[0].respond({status: 'submitted', inputCleared: true, requestId: '2'});
  await next; assert.equal(children.length, 1);
});

for (const [name, response] of [['malformed', '{\n'], ['wrong request', '{"status":"submitted","inputCleared":true,"requestId":"999"}\n'], ['oversized', 'a'.repeat(10001)]]) {
  test(`sender rejects ${name} output without a retry`, async t => {
    const {sender, children} = fixture(t);
    const pending = sender.send(request);
    const rejected = assert.rejects(pending, error => error.code === 'INVALID_RESPONSE');
    await tick(); children[0].stdout.write(response); await rejected; await tick();
    assert.equal(children[0].kills, 1); assert.equal(children[0].requests.length, 1); assert.equal(children.length, 1);
  });
}

test('timed-out worker is killed and only a later explicit request creates another worker', async t => {
  const {sender, children} = fixture(t, {requestTimeoutMs: 20});
  await assert.rejects(sender.send(request), error => error.code === 'TIMEOUT');
  assert.equal(children[0].kills, 1); assert.equal(children.length, 1);
  const next = sender.send(request); await tick();
  assert.equal(children.length, 2);
  children[1].respond({status: 'submitted', inputCleared: true, requestId: '2'});
  await next;
});

test('startup timeout and cancellation reject readiness without writing a request', async t => {
  const timed = fixture(t, {ready: false, startupTimeoutMs: 20});
  await assert.rejects(timed.sender.send(request), error => error.code === 'START_FAILED');
  assert.equal(timed.children[0].requests.length, 0);
  const stopped = fixture(t, {ready: false});
  const warm = assert.rejects(stopped.sender.warm(), error => error.code === 'SUBMISSION_UNCONFIRMED');
  await stopped.sender.stop(); await warm;
  assert.equal(stopped.children[0].requests.length, 0);
});

test('worker exit after a request is reported as unconfirmed with no automatic restart', async t => {
  const {sender, children} = fixture(t);
  const rejected = assert.rejects(sender.send(request), error => error.code === 'SUBMISSION_UNCONFIRMED');
  await tick(); children[0].emit('close', 1); await rejected;
  assert.equal(children[0].requests.length, 1); assert.equal(children.length, 1);
});

test('invalid requests are rejected before starting the worker', async t => {
  const {sender, children} = fixture(t);
  await assert.rejects(sender.send({...request, text: ''}));
  assert.equal(children.length, 0);
});

test('reply selection must succeed before the sender writes text or Enter requests',async t=>{
  let failure=true,calls=0;
  const {sender,children}=fixture(t,{replySelector:{async prepare(value,python){calls++;assert.equal(value.text,undefined);assert.deepEqual(value.inputTarget,inputTarget);assert.equal(python,'fixture-worker');if(failure)throw Object.assign(new Error('conflict'),{code:'REPLY_CONFLICT'});},async stop(){}}});
  const reply={...request,replyTo:{id:'9000000000000002001',senderId:'90000002'}};
  await assert.rejects(sender.send(reply,{workerPath:'fixture-worker'}),e=>e.code==='REPLY_CONFLICT');assert.equal(children[0].requests.length,1);
  assert.deepEqual(children[0].requests[0],{operation:'prepare',pid:request.pid,roomId:request.roomId,roomTitle:request.roomTitle,requestId:'1'});
  failure=false;const pending=sender.send(reply,{workerPath:'fixture-worker'});await tick();assert.deepEqual(children[0].requests[2].replyTo,reply.replyTo);
  children[0].respond({status:'submitted',inputCleared:true,requestId:'3'});await pending;assert.equal(calls,2);
});
test('disconnect during reply selection prevents later text submission even when selection finishes',async t=>{
  let finish;
  const {sender,children}=fixture(t,{replySelector:{prepare:()=>new Promise(resolve=>{finish=resolve;}),async stop(){finish?.();}}});
  const pending=assert.rejects(sender.send({...request,replyTo:{id:'100',senderId:'2'}},{workerPath:'fixture-worker'}));await tick();await sender.stop();await pending;assert.equal(children[0].requests.length,1);assert.equal(children[0].requests[0].text,undefined);
});

for(const [name,patch] of [['wrong room',{roomId:'456'}],['missing target',{inputTarget:null}],['null pointer',{inputTarget:{...inputTarget,dialog:'0x0'}}],['invalid pointer',{inputTarget:{...inputTarget,editor:'hello'}}],['missing process session',{inputTarget:{...inputTarget,processStartFileTime:''}}]]) {
  test(`reply preparation rejects ${name} before selection and text submission`,async t=>{
    let selected=false;
    const {sender,children}=fixture(t,{autoPrepare:false,replySelector:{async prepare(){selected=true;},async stop(){}}});
    const pending=assert.rejects(sender.send({...request,replyTo:{id:'100',senderId:'2'}}),e=>e.code==='INVALID_RESPONSE');
    await tick();children[0].respond({status:'prepared',roomId:request.roomId,inputTarget,requestId:'1',...patch});await pending;
    assert.equal(selected,false);assert.equal(children[0].requests.length,1);assert.equal(children[0].requests[0].text,undefined);
  });
}
test('reply preparation timeout never advances to selection or submission',async t=>{
  let selected=false;
  const {sender,children}=fixture(t,{autoPrepare:false,requestTimeoutMs:20,replySelector:{async prepare(){selected=true;},async stop(){}}});
  await assert.rejects(sender.send({...request,replyTo:{id:'100',senderId:'2'}}),e=>e.code==='TIMEOUT');
  assert.equal(selected,false);assert.equal(children[0].requests.length,1);assert.equal(children[0].requests[0].text,undefined);
});

test('PowerShell worker starts and shuts down over private stdio without sending', {skip: process.platform !== 'win32'}, async t => {
  const sender = new ClientSender(path.resolve(__dirname, '..'));
  t.after(() => sender.stop());
  await sender.warm();
  assert.equal(sender.session.state, 'ready');
  assert.equal(sender.sequence, 0);
  await sender.stop();
  assert.equal(sender.session, undefined);
});
