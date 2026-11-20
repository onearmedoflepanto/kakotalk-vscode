'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const path=require('node:path');
const {ReplyClient}=require('../src/reply-client.cjs');
const request={pid:42,roomId:'123',roomTitle:'테스트',replyTo:{id:'9000000000000002001',senderId:'90000002'},text:'never passed to selector'};
const prepared={status:'prepared',clean:true,roomId:request.roomId,replyId:request.replyTo.id};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,timeoutMs=1000){
  const children=[];
  const selector=new ReplyClient('fixture',{timeoutMs,spawnProcess:(program,args,options)=>{
    assert.equal(options.windowsHide,true);assert.equal(options.shell,false);assert.ok(!args.includes(request.text));
    const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.requests=[];c.kills=0;
    c.stdin.on('data',b=>c.requests.push(JSON.parse(b.toString('utf8'))));
    c.kill=()=>{c.kills++;queueMicrotask(()=>c.emit('close',1));};
    c.finish=(value,code=0)=>{if(value!==undefined)c.stdout.write(JSON.stringify(value)+'\n');queueMicrotask(()=>{c.stdout.once('close',()=>c.emit('close',code));c.emit('exit',code);if(!value)c.emit('close',code);});};
    children.push(c);return c;
  }});
  t.after(()=>selector.stop());return {selector,children};
}
test('reply selector sends only routing identity and accepts cleanup plus worker exit with inherited pipes',async t=>{
  const {selector,children}=fixture(t);const pending=selector.prepare(request,path.resolve('python.exe'));await tick();
  assert.deepEqual(children[0].requests[0],{pid:request.pid,roomId:request.roomId,roomTitle:request.roomTitle,replyTo:request.replyTo});
  children[0].finish(prepared);assert.deepEqual(await pending,prepared);assert.equal(children[0].kills,0);assert.equal(selector.child,undefined);
});
test('reply selector passes the process-bound input target over private stdio without message text',async t=>{
  const {selector,children}=fixture(t),inputTarget={dialog:'0x100000',window:'0x200000',editor:'0x300000',processStartFileTime:'134077000000000000'};
  const pending=selector.prepare({...request,inputTarget},path.resolve('python.exe'));await tick();
  assert.deepEqual(children[0].requests[0],{pid:request.pid,roomId:request.roomId,roomTitle:request.roomTitle,replyTo:request.replyTo,inputTarget});
  children[0].finish(prepared);await pending;
});
for(const [label,patch] of [['wrong room',{roomId:'456'}],['wrong source',{replyId:'9'}],['unclean detach',{clean:false}],['selection conflict',{status:'error',code:'REPLY_CONFLICT'}]]){
  test(`reply selector rejects ${label} before submission`,async t=>{
    const {selector,children}=fixture(t);const pending=assert.rejects(selector.prepare(request,path.resolve('python.exe')));await tick();children[0].finish({...prepared,...patch});await pending;
  });
}
test('reply selector timeout is not retried and closes its process',async t=>{
  const {selector,children}=fixture(t,20);await assert.rejects(selector.prepare(request,path.resolve('python.exe')));assert.equal(children.length,1);assert.equal(children[0].kills,1);
});
test('reply selector rejects a second concurrent operation and stops a queued request',async t=>{
  const {selector,children}=fixture(t);const pending=assert.rejects(selector.prepare(request,path.resolve('python.exe')));await tick();
  await assert.rejects(selector.prepare(request,path.resolve('python.exe')));const stopped=selector.stop();assert.equal(children[0].stdin.writableEnded,true);children[0].finish({status:'error',code:'REPLY_PREPARE_FAILED',clean:true});await pending;await stopped;assert.equal(children.length,1);
});
