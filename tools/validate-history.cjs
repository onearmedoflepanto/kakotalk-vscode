'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ReceiverClient} = require('../src/receiver-client.cjs');
const {resolveWorker} = require('../src/runtime.cjs');
const {renderWebview} = require('../src/webview.cjs');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'.generated/integration/history-validation.json');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function native(roomId) {
  assert.match(roomId,/^[1-9][0-9]{0,19}$/);
  const client = new ReceiverClient(root), records = new Map(), diagnostics=[];
  const result={at:new Date().toISOString(),roomId,sentMessages:0,pages:[]};
  client.on('message', m=>records.set(m.id,m));client.on('diagnostic',value=>{if(value.counters)diagnostics.push(value.counters);if(value.status==='error'&&value.message)console.error(value.message);});
  try {
    const workerPath=await resolveWorker({root:path.join(root,'.generated/releases')});
    await client.connect({roomId,workerPath,duration:120});await pause(250);
    const ids=()=>[...records.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
    assert.ok(records.size>0,'Initial local messages');result.initialCount=records.size;
    let before=ids()[0];
    for(let i=0;i<3;i++) {
      const at=Date.now(), page=await client.history({roomId,before});
      assert.ok(page.messages.length>0 && page.messages.length<=10,'A nonempty older page');
      for(const m of page.messages){assert.equal(m.roomId,roomId);assert.ok(BigInt(m.id)<BigInt(before));records.set(m.id,m);}
      result.pages.push({count:page.messages.length,elapsedMs:Date.now()-at,source:page.source,scrolled:page.scrolled});
      before=page.messages[0].id;
    }
    const empty=await client.history({roomId,before:'1'});
    assert.equal(empty.messages.length,0);assert.equal(empty.scrolled,true);
    result.boundedScroll={scrolled:true,messages:0};result.uniqueCount=records.size;result.passed=true;
  } finally {result.cleanup=await client.stop();await client.dispose();}
  return result;
}
async function ui() {
  const {chromium}=require(path.join(root,'.generated/agent-panel-preview/node_modules/playwright-core'));
  const executablePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
  const browser=await chromium.launch({executablePath,headless:true});const checks=[],errors=[];
  const record=id=>({version:1,type:'message',source:'client',id:String(id),roomId:'1',roomTitle:'대화',senderId:'20',sender:'사용자',text:`메시지 ${id}\n${'긴 본문 '.repeat(25)}`,timestamp:'2026-11-17T00:00:00Z'});
  const state={type:'state',mode:'live',activeRoomId:'1',activeRoomTitle:'대화',status:'로컬 수신 연결됨',selfId:'30',canSend:true,sendingEnabled:true,
    messages:Array.from({length:30},(_,n)=>record(n+11)),history:{floor:'',loading:false},roomPicker:{open:false,rooms:[{id:'1',title:'대화'}]}};
  try {
    const context=await browser.newContext({viewport:{width:400,height:700}});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());if(url.origin!=='http://history.local')return route.abort();
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:renderWebview({cssUri:'/chat.css',scriptUri:'/chat.js',cspSource:"'self'",nonce:'history'})});
      if(['/chat.css','/chat.js'].includes(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(root,'media',url.pathname.slice(1)))});
      return route.abort();
    });
    await context.addInitScript(initial=>{
      window.requests=[];window.state=initial;
      window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:message=>{window.requests.push(message);if(message.type==='ready')window.postMessage(window.state,'*');}});
    },state);
    const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.setDefaultTimeout(10000);await page.goto('http://history.local');
    await page.waitForFunction(()=>document.querySelectorAll('article').length===10);
    assert.equal(await page.locator('article').first().getAttribute('data-message-id'),'31');checks.push('entry displays latest ten');
    await page.locator('#messages').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));});
    await page.waitForFunction(()=>window.requests.some(r=>r.type==='history'));
    assert.equal(await page.evaluate(()=>window.requests.find(r=>r.type==='history').before),'31');
    const send=value=>page.evaluate(s=>window.postMessage(s,'*'),value);
    state.history={floor:'31',loading:true};await send(state);await page.waitForFunction(()=>document.querySelector('.history-load').disabled);
    const anchorBefore=await page.locator('[data-message-id="31"]').evaluate(e=>e.getBoundingClientRect().top);
    await page.locator('#messages').evaluate(e=>e.dispatchEvent(new WheelEvent('wheel',{deltaY:-100})));
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.type==='history').length),1);checks.push('pending requests coalesce');
    state.history={floor:'21',loading:false};await send(state);await page.waitForFunction(()=>document.querySelectorAll('article').length===20);
    const anchorAfter=await page.locator('[data-message-id="31"]').evaluate(e=>e.getBoundingClientRect().top);
    assert.ok(Math.abs(anchorAfter-anchorBefore)<2,`Reading anchor moved ${anchorAfter-anchorBefore}`);checks.push('prepend preserves reading anchor');
    const top=await page.locator('#messages').evaluate(e=>e.scrollTop);state.messages.push(record(41));await send(state);
    await page.waitForFunction(()=>document.querySelectorAll('article').length===21);assert.equal(await page.locator('#messages').evaluate(e=>e.scrollTop),top);checks.push('live arrival preserves history position');
    state.history={floor:'21',loading:false,empty:true};await send(state);await page.waitForFunction(()=>document.querySelector('.history-load').textContent.includes('다시 확인'));
    await pause(550);await page.locator('#messages').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));});
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.type==='history').length),1);
    await page.locator('.history-load').click();await page.waitForFunction(()=>window.requests.filter(r=>r.type==='history').length===2);checks.push('empty page waits for explicit retry');
    state.history={floor:'',loading:false};state.activeRoomId='2';state.messages=[{...record(1),roomId:'2'}];state.roomPicker.rooms=[{id:'2',title:'다른 방'}];await send(state);
    await page.waitForFunction(()=>document.querySelectorAll('article').length===1);assert.equal(await page.locator('article').getAttribute('data-message-id'),'1');checks.push('room switch resets history');
    assert.deepEqual(errors,[]);return {at:new Date().toISOString(),passed:true,checks};
  } finally {await browser.close();}
}
(async()=>{
  const mode=process.argv[2]||'ui', prior=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{};
  prior[mode]=mode==='native'?await native(process.argv[3]):await ui();fs.writeFileSync(output,JSON.stringify(prior,null,2)+'\n');console.log(JSON.stringify(prior[mode],null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
