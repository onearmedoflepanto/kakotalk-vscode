'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../tools/reply-agent.js'),'utf8');
const builds=Object.values(require('../tools/client-builds.json'));
function fixture(build=builds[0]){
  const memory=new Map(); let scans=0,owner=42,draft='',undo=false;
  class Pointer {
    constructor(value){this.value=Number(value);}
    add(n){return new Pointer(this.value+n);}
    readPointer(){return new Pointer(memory.get(this.value)||0);}
    readU64(){return {toString:()=>String(memory.get(this.value)||0)};}
    equals(other){return this.value===other.value;}
    isNull(){return this.value===0;}
    toString(){return '0x'+this.value.toString(16);}
  }
  const ptr=value=>new Pointer(value),base=0x10000000,dialog=0x100000,model=0x110000,room=0x120000,info=0x130000,input=0x140000,editorObject=0x150000,window=0x200000,editor=0x300000;
  for(const [at,value] of [[dialog,base+Number(build.tables.CChatDlg)],[model,base+Number(build.tables.ChatRoom_ViewModel)],[room,base+Number(build.tables.TalkChatRoom)],[input,base+Number(build.tables.ChatDelegate_Input)],
    [dialog+0x640,model],[model+0xe8,room],[room+0x188,info],[info+0x18,123],[dialog+0xbe8,input],
    [input+0x38,model],[input+0x28,dialog],[dialog+0x40,window],[input+0x48,editorObject],[editorObject+0x40,editor]])memory.set(at,value);
  const sandbox={CLIENT_BUILD:build,rpc:{exports:{}},Process:{id:42,getModuleByName:name=>name==='KakaoTalk.exe'?{base:ptr(base)}:{getExportByName:n=>n},enumerateRanges(){scans++;throw Error('Unexpected full scan');}},
    Memory:{alloc:()=>({value:0,text:'',readU32(){return this.value;},readUtf16String(){return this.text;}})},ptr,
    NativeFunction:function(name){return (...args)=>{
      if(name==='GetWindowTextW'){args[1].text='테스트';return 3;}
      if(name==='IsWindow')return true;
      if(name==='GetWindowThreadProcessId'){args[1].value=owner;return 1;}
      if(name==='SendMessageW'){if(args[1]===13){args[3].text=draft;return {toNumber:()=>draft.length};}if(args[1]===0xc6)return undo?1:0;}
      throw Error('Unexpected native API: '+name);
    };}};
  vm.runInNewContext(source,sandbox);
  const request={roomId:'123',roomTitle:'테스트',inputTarget:{dialog:ptr(dialog).toString(),window:ptr(window).toString(),editor:ptr(editor).toString()}};
  return {request,locate:r=>sandbox.locate(r),empty:()=>sandbox.empty(ptr(editor)),memory,setOwner:v=>{owner=v;},setDraft:(v,u)=>{draft=v;undo=u;},scans:()=>scans};
}
for(const build of builds)test(`validated input target skips memory enumeration on ${build.version}`,()=>{
  const f=fixture(build),result=f.locate(f.request);assert.equal(result.window.toString(),f.request.inputTarget.window);assert.equal(f.scans(),0);
});
for(const [name,change] of [['editor replaced',f=>{f.memory.set(0x150040,0x300008);}],['room changed',f=>{f.memory.set(0x130018,456);}],['parent changed',f=>{f.memory.set(0x140028,0x100008);}],['window owner changed',f=>f.setOwner(43)]]) {
  test(`stale target rejects ${name} without falling back to a scan`,()=>{
    const f=fixture();change(f);assert.throws(()=>f.locate(f.request),e=>e.code==='ROOM_CHANGED');assert.equal(f.scans(),0);
  });
}
test('reply selector distinguishes all placeholder kinds from typed drafts',()=>{
  const f=fixture();
  for(const hint of ['메시지 입력','답장 메시지 입력','댓글 메시지 입력']){
    f.setDraft(hint,false);f.empty();f.setDraft(hint,true);assert.throws(()=>f.empty(),e=>e.code==='DRAFT_EXISTS');
  }
  f.setDraft('existing draft',false);assert.throws(()=>f.empty(),e=>e.code==='DRAFT_EXISTS');
});
