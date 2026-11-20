'use strict';
// Build-gated native UI selection. No transport, serialization or server API is used.
const base = Process.getModuleByName('KakaoTalk.exe').base;
const user32 = Process.getModuleByName('user32.dll');
const api = (name,result,args) => new NativeFunction(user32.getExportByName(name),result,args);
const getText = api('GetWindowTextW','int',['pointer','pointer','int']);
const sendWindow = api('SendMessageW','uint64',['pointer','uint','uint64','pointer']);
const sendTimeout = api('SendMessageTimeoutW','pointer',['pointer','uint','pointer','pointer','uint','uint','pointer']);
const windowProcedure = api('GetWindowLongPtrW','pointer',['pointer','int']);
const registerMessage = api('RegisterWindowMessageW','uint',['pointer']);
const isWindow = api('IsWindow','bool',['pointer']);
const isIconic = api('IsIconic','bool',['pointer']);
const isVisible = api('IsWindowVisible','bool',['pointer']);
const foreground = api('GetForegroundWindow','pointer',[]);
const owner = api('GetWindowThreadProcessId','uint',['pointer','pointer']);
let dispatch;
let listener, pending, cancelled = false, originalDispatch;
const bytes = p => Array.from(new Uint8Array(p.readByteArray(16))).join(',');
const fail = code => { throw Object.assign(new Error(code),{code}); };
function title(hwnd) { const b=Memory.alloc(514); const n=getText(hwnd,b,257); return n>0?b.readUtf16String(n):''; }
function owned(hwnd) { const p=Memory.alloc(4);owner(hwnd,p);return isWindow(hwnd)&&p.readU32()===Process.id; }
function matches(p,rva) { try{return p.readPointer().equals(base.add(rva));}catch(_){return false;} }
function context(dialog,request) {
  if(!matches(dialog,Number(CLIENT_BUILD.tables.CChatDlg)))fail('ROOM_CHANGED');
  const model=dialog.add(0x640).readPointer(), room=model.add(0xe8).readPointer(), info=room.add(0x188).readPointer(), input=dialog.add(0xbe8).readPointer();
  if(!matches(model,Number(CLIENT_BUILD.tables.ChatRoom_ViewModel))||!matches(room,Number(CLIENT_BUILD.tables.TalkChatRoom))||!matches(input,Number(CLIENT_BUILD.tables.ChatDelegate_Input))||info.add(0x18).readU64().toString()!==request.roomId||!input.add(0x38).readPointer().equals(model)||!input.add(0x28).readPointer().equals(dialog))fail('ROOM_CHANGED');
  const window=dialog.add(0x40).readPointer(),editor=input.add(0x48).readPointer().add(0x40).readPointer();
  if(!owned(window)||!owned(editor)||title(window)!==request.roomTitle)fail('ROOM_CHANGED');
  return {dialog,input,window,editor};
}
function locate(request) {
  if(request.inputTarget!==undefined) {
    const target=request.inputTarget;
    if(!target||!['dialog','window','editor'].every(key=>typeof target[key]==='string'&&/^0x[0-9a-f]{1,16}$/i.test(target[key])))fail('ROOM_CHANGED');
    const c=context(ptr(target.dialog),request);
    if(!c.window.equals(ptr(target.window))||!c.editor.equals(ptr(target.editor)))fail('ROOM_CHANGED');
    return c;
  }
  const candidates=[],pattern=base.add(Number(CLIENT_BUILD.tables.CChatDlg)).toMatchPattern(),started=Date.now();let total=0;
  for(const r of Process.enumerateRanges('rw-')) {
    total+=r.size;if(total>1024*1024*1024||Date.now()-started>6000)fail('REPLY_UNAVAILABLE');
    // Bound each read, including large regions, without silently omitting candidate objects.
    for(let at=0;at<r.size;at+=1024*1024-8) {
      let hits;try{hits=Memory.scanSync(r.base.add(at),Math.min(1024*1024,r.size-at),pattern);}catch(_){continue;}
      for(const hit of hits){try{const c=context(hit.address,request);if(!candidates.some(x=>x.dialog.equals(c.dialog)))candidates.push(c);}catch(_){}}
    }
  }
  if(candidates.length!==1)fail('REPLY_UNAVAILABLE');return candidates[0];
}
function empty(editor) {
  const data=Memory.alloc(4004),n=sendWindow(editor,13,2002,data).toNumber();
  if(n>2001)fail('DRAFT_EXISTS');
  const text=data.readUtf16String(n),undo=sendWindow(editor,0xc6,0,ptr(0)).toString()!=='0';
  if(text!==''&&(!['메시지 입력','답장 메시지 입력','댓글 메시지 입력'].includes(text)||undo))fail('DRAFT_EXISTS');
}
function selection(c,request) {
  return c.input.add(0x88).readU32()===1 && c.input.add(0x450).readU8()===1 &&
    c.input.add(0x288).readU64().toString()===request.replyTo.id && c.input.add(0x290).readU64().toString()===request.roomId && c.input.add(0x2a0).readU64().toString()===request.replyTo.senderId;
}
function detach() { if(listener){listener.detach();listener=undefined;Interceptor.flush();} }
function cancel() { cancelled=true;if(pending){const done=pending;pending=undefined;done({status:'error',code:'REPLY_PREPARE_FAILED'});}detach(); }
rpc.exports = {
  async prepare(request) {
    try {
      if(cancelled||Process.arch!=='x64'||!Number.isInteger(request.pid)||request.pid!==Process.id||!/^[0-9a-f]{32}$/.test(request.nonce))fail('REPLY_PREPARE_FAILED');
      const functionAt=base.add(Number(CLIENT_BUILD.replySelector));
      if(bytes(functionAt)!==[0x48,0x89,0x5c,0x24,0x20,0x55,0x56,0x57,0x41,0x54,0x41,0x55,0x41,0x56,0x41,0x57].join(','))fail('REPLY_PREPARE_FAILED');
      const found=locate(request);
      const message=registerMessage(Memory.allocUtf16String('LocalChat.Reply.'+request.nonce));
      if(message<0xc000)fail('REPLY_PREPARE_FAILED');
      const token=ptr('0x'+request.nonce.slice(0,8)),token2=ptr('0x'+request.nonce.slice(8,16));
      dispatch=windowProcedure(found.window,-4);
      if(dispatch.isNull())fail('REPLY_PREPARE_FAILED');
      originalDispatch=bytes(dispatch);
      const deadline=Date.now()+5000;
      const selectNative=new NativeFunction(functionAt,'bool',['pointer','uint64','uint','bool']);
      return await new Promise(resolve=>{
        const timer=setTimeout(()=>{if(pending){pending=undefined;resolve({status:'error',code:'REPLY_PREPARE_FAILED'});}detach();},5000);
        pending=result=>{clearTimeout(timer);resolve(result);};
        listener=Interceptor.attach(dispatch,{onEnter(args){
          if(!pending||cancelled||Date.now()>deadline||!args[0].equals(found.window)||args[1].toUInt32()!==message||!args[2].equals(token)||!args[3].equals(token2))return;
          // The nonce message is ours; the original procedure receives only WM_NULL.
          args[1]=ptr(0);args[2]=ptr(0);args[3]=ptr(0);
          const done=pending;pending=undefined;
          try {
            const c=context(found.dialog,request);empty(c.editor);
            const previous={foreground:foreground(),minimized:isIconic(c.window),visible:isVisible(c.window)};
            if(c.input.add(0x88).readU32()!==0&&!selection(c,request))fail('REPLY_CONFLICT');
            const selected=selection(c,request)||selectNative(c.input,uint64(request.replyTo.id),1,0);
            if(!selected||!selection(context(c.dialog,request),request))fail('REPLY_MISMATCH');
            if(!foreground().equals(previous.foreground)||isIconic(c.window)!==previous.minimized||isVisible(c.window)!==previous.visible)fail('REPLY_PREPARE_FAILED');
            empty(c.editor);
            done({status:'prepared',roomId:request.roomId,replyId:request.replyTo.id,minimized:previous.minimized,visible:previous.visible,foregroundPreserved:true});
          } catch(error) { done({status:'error',code:error.code||'REPLY_PREPARE_FAILED'}); }
        }});
        Interceptor.flush();
        const sent=!cancelled&&!sendTimeout(found.window,message,token,token2,0x23,3000,Memory.alloc(8)).isNull();
        if(!sent&&pending){const done=pending;pending=undefined;done({status:'error',code:'REPLY_PREPARE_FAILED'});detach();}
      });
    } catch(error) {return {status:'error',code:error.code||'REPLY_PREPARE_FAILED'};}
  },
  cancel,
  stop(){cancel();return !originalDispatch||bytes(dispatch)===originalDispatch;}
};
