'use strict';
// Local read-only integration. Never submits input, invokes buttons or contacts a server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {ReceiverClient} = require('../src/receiver-client.cjs');
const {resolveWorker} = require('../src/runtime.cjs');

async function main() {
  const root=path.resolve(__dirname,'..'), selected=process.argv[2], expected=process.argv[3];
  const client=new ReceiverClient(root), messages=[], diagnostics=[];
  const result={at:new Date().toISOString(),selected,expected,sends:0,buttonInvocations:0};
  client.on('message',m=>messages.push(m));client.on('diagnostic',d=>diagnostics.push(d));
  try {
    const rooms=await client.discover();result.roomCount=rooms.length;assert.ok(rooms.every(r=>Number.isInteger(r.unreadCount)));
    if(selected) {
      assert.ok(rooms.some(r=>r.id===selected));
      const workerPath=await resolveWorker({root:path.join(root,'.generated/releases')});
      const ended=once(client,'ended');await client.connect({workerPath,roomId:selected,duration:3});
      result.termination=(await ended)[0];assert.equal(result.termination.clean,true);
      assert.ok(messages.some(m=>(m.kind||'text')===expected),'Expected rich message must reach receiver client');
      if(expected==='reply')assert.ok(messages.some(m=>m.reply?.id&&m.reply?.text));
      if(expected==='card')assert.ok(messages.some(m=>m.buttons?.some(b=>b.url)));
    }
    result.messages=messages.map(m=>({id:m.id,kind:m.kind||'text',observation:m.observation,textLength:m.text.length,textSha256:createHash('sha256').update(m.text).digest('hex'),replyId:m.reply?.id,buttons:m.buttons?.map(b=>({label:b.label,hasUrl:Boolean(b.url)}))}));
    result.passed=true;
  } finally {
    result.diagnostics=diagnostics;await client.dispose();
    const output=path.join(root,'.generated/integration/receiver-'+(expected||'rooms')+'.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({passed:Boolean(result.passed),roomCount:result.roomCount,messages:result.messages,termination:result.termination,output},null,2));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
