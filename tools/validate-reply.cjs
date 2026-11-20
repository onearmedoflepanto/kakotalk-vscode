'use strict';
// --request selects the local test target; --send also submits its text.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {once}=require('node:events');
const {ReplyClient}=require('../src/reply-client.cjs');
const {ClientSender,validateSend}=require('../src/client-ui.cjs');
const {ReceiverClient}=require('../src/receiver-client.cjs');
const {resolveWorker}=require('../src/runtime.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),send=args.includes('--send');
  const index=args.indexOf('--request'),filename=args[index+1];
  if(index<0||!filename||filename.startsWith('--')||args.filter((_,i)=>i!==index&&i!==index+1).some(arg=>arg!=='--send'))throw new Error('Usage: node tools/validate-reply.cjs --request <local-request.json> [--send]');
  const request=validateSend(JSON.parse(fs.readFileSync(path.resolve(filename),'utf8').replace(/^\uFEFF/,'')));
  if(!request.replyTo)throw new Error('The request must include replyTo.');
  const workerPath=await resolveWorker({root:path.join(root,'.generated/releases')});
  const selector=new ReplyClient(root),sender=new ClientSender(root),receiver=new ReceiverClient(root);
  const result={at:new Date().toISOString(),mode:send?'send':'prepare',roomId:request.roomId,sourceId:request.replyTo.id,sends:0};
  let timer;
  try{
    if(!send){result.selection=await selector.prepare(request,workerPath);assert.equal(result.selection.foregroundPreserved,true);}
    else {
      const observed=new Promise((resolve,reject)=>{
        receiver.on('message',m=>{if(m.text===request.text&&m.reply?.id===request.replyTo.id&&m.senderId===request.replyTo.senderId&&m.observation==='ui-model-setter')resolve(m);});
        timer=setTimeout(()=>reject(new Error('Native reply receipt was not observed.')),60000);
      });
      observed.catch(()=>{});
      const ready=once(receiver,'ready');await receiver.connect({workerPath,roomId:request.roomId,duration:60});await ready;
      await sender.warm();result.submission=await sender.send(request,{workerPath});result.sends=1;
      const message=await observed;result.receipt={id:message.id,kind:message.kind,replyId:message.reply.id,senderId:message.senderId,observation:message.observation};
    }
    result.passed=true;
  }finally{
    clearTimeout(timer);await selector.stop();await sender.stop();result.receiverStop=await receiver.stop();await receiver.dispose();
    const output=path.join(root,'.generated/integration/reply-'+result.mode+'.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,output},null,2));
  }
}
main().catch(error=>{console.error(error.code||error.message);if(error.diagnostic)console.error(error.diagnostic);process.exitCode=1;});
