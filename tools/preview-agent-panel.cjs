'use strict';

// Render the production webview with a simulated VS Code host and synthetic messages.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {renderWebview} = require('../src/webview.cjs');
const {sampleMessages} = require('../tests/fixtures/messages.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.generated', 'agent-panel-preview');
const {chromium} = require(path.join(output, 'node_modules', 'playwright-core'));
const executablePath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(file => fs.existsSync(file));
const records = sampleMessages();
const initial = {type: 'state', mode: 'live', status: '로컬 수신 연결됨', selfId: '100', messages: records,
  roomPicker: {open:false,rooms:[...new Map(records.map(m=>[m.roomId,{id:m.roomId,title:m.roomTitle}])).values()]}};
const theme = light => `:root {
  --vscode-font-family: 'Segoe UI', 'Malgun Gothic', sans-serif;
  --vscode-font-size: 13px;
  --vscode-sideBar-background: ${light ? '#f8f8f8' : '#1c1f24'};
  --vscode-foreground: ${light ? '#333333' : '#c5c5c7'};
  --vscode-descriptionForeground: ${light ? '#616161' : '#969ba5'};
  --vscode-chat-requestBubbleBackground: ${light ? '#ededed' : '#25282e'};
  --vscode-chat-requestBorder: ${light ? '#dddddd' : '#2c2f34'};
  --vscode-menu-background: ${light ? '#ffffff' : '#25282e'};
  --vscode-focusBorder: #007fd4;
}`;

async function main() {
  assert.ok(executablePath, 'A local Edge or Chrome installation is required.');
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({executablePath, headless: true});
  const checks = [];
  const errors = [];
  try {
    const context = await browser.newContext({viewport: {width: 400, height: 900}, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce'});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://local-chat.preview') return route.abort();
      if (url.pathname === '/') {
        const light = url.searchParams.get('theme') === 'light';
        const html = renderWebview({cssUri: '/chat.css', scriptUri: '/chat.js', cspSource: "'self'", nonce: 'local-preview'})
          .replace('</head>', `<link rel="stylesheet" href="/theme.css?light=${light}"></head>`)
          .replace('<body>', `<body class="${light ? 'vscode-light' : 'vscode-dark'}">`);
        return route.fulfill({contentType: 'text/html; charset=utf-8', body: html});
      }
      if (url.pathname === '/theme.css') return route.fulfill({contentType: 'text/css', body: theme(url.searchParams.get('light') === 'true')});
      if (['/chat.css', '/chat.js'].includes(url.pathname)) {
        return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(root, 'media', url.pathname.slice(1)))});
      }
      return route.abort();
    });
    await context.addInitScript(state => {
      window.previewState = state;
      window.hostRequests = [];
      let saved;
      window.acquireVsCodeApi = () => ({
        getState: () => saved,
        setState: value => { saved = value; },
        postMessage: message => {
          window.hostRequests.push(message);
          if (message.type === 'ready') window.postMessage(window.previewState, '*');
        }
      });
    }, initial);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://local-chat.preview/');
    await page.locator('#room-list button').first().waitFor();
    assert.equal(await page.locator('#room-list button').count(), 4);
    await page.screenshot({path: path.join(output, 'home.png')});
    assert.equal(await page.locator('#connect, #empty-connect, #close-picker, #available-rooms, #view-all').count(), 0);
    await page.locator('#room-list button').first().click();
    assert.deepEqual(errors, [], 'Browser errors after opening a conversation');
    assert.equal(await page.locator('.outgoing').count(), 1);
    assert.equal(await page.locator('.incoming').count(), 1);
    await page.locator('#settings').focus();
    await page.mouse.move(0, 0);
    await page.screenshot({path: path.join(output, 'conversation.png')});
    checks.push('One Chats list with no separate discovery/connection controls, room navigation and sender alignment');

    assert.equal(await page.locator('.message button:not(.message-reply)').count(), 0);
    assert.deepEqual(await page.locator('.incoming .message-meta').evaluate(e=>[...e.children].map(n=>n.className||n.tagName)),['sender','message-reply','TIME']);
    assert.equal(await page.locator('.composer-footer > :not(.composer)').count(), 0);
    assert.equal(await page.locator('.composer #status-dot').count(), 1);
    assert.equal(await page.locator('#status-dot').textContent(), '');
    assert.equal(await page.locator('#send-mode, #status, #source, #warning, #send-status, #copy-icon').count(), 0);
    await page.locator('#settings').click();
    assert.ok(await page.evaluate(() => window.hostRequests.some(value => value.type === 'settings')));
    assert.equal(await page.locator('#history, #more, #room-selector, #room-menu').count(),0);
    assert.equal(await page.locator('#back').count(),1);
    assert.equal(await page.locator('[aria-controls="actions-menu"]').count(),1);
    await page.locator('#back').click();
    assert.equal(await page.locator('#room-search').evaluate(element => element === document.activeElement),true);
    await page.locator('#room-list button').nth(1).click();
    assert.equal(await page.locator('#panel-title').textContent(), '이번 주 코드 리뷰');
    checks.push('Single back arrow opens Chats; settings and composer status remain without duplicate navigation controls');

    await page.locator('#composer-menu').click();
    assert.equal(await page.locator('.composer #actions-menu').isVisible(),true);
    assert.equal(await page.locator('#composer-menu').getAttribute('aria-expanded'),'true');
    assert.deepEqual(await page.locator('#actions-menu button').allTextContents(),['연결 끊기','답장 기능 켜기','연결 로그 보기']);
    assert.equal(await page.locator('#show-chats').count(),0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#composer-menu').evaluate(e=>e===document.activeElement),true);
    await page.locator('#composer-menu').click();assert.equal(await page.locator('.composer #actions-menu').isVisible(),true);
    await page.locator('#logs').click();
    assert.equal(await page.locator('#actions-menu').isVisible(),false);
    assert.equal(await page.locator('#composer-menu').getAttribute('aria-expanded'),'false');
    assert.equal(await page.evaluate(()=>window.hostRequests.at(-1).type),'logs');
    checks.push('One composer menu opens above the input and restores focus after Escape or action selection');

    await page.locator('#back').click();
    await page.locator('#room-list button').first().click();
    for (const width of [280, 320, 400]) {
      await page.setViewportSize({width, height: 900});
      assert.ok(await page.evaluate(() => {
        const main = document.getElementById('messages');
        const composer = document.querySelector('.composer');
        return document.documentElement.scrollWidth <= innerWidth && main.scrollWidth <= main.clientWidth &&
          main.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top && composer.getBoundingClientRect().right <= innerWidth;
      }), `Layout overflow at ${width}px`);
      assert.ok(await page.locator('.outgoing-row').evaluate(row=>{
        const time=row.querySelector('time').getBoundingClientRect(),body=row.querySelector('.message-body').getBoundingClientRect(),reply=row.querySelector('.message-reply').getBoundingClientRect();
        return time.right<=body.left&&reply.right<=body.left&&reply.bottom<=time.top&&Math.abs(time.bottom-(body.bottom-4))<2;
      }),`Outgoing reply and timestamp placement at ${width}px`);
      await page.locator('#composer-menu').click();
      assert.ok(await page.locator('#actions-menu').evaluate(e=>{
        const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=document.getElementById('composer-menu').getBoundingClientRect().top;
      }),`Composer menu placement at ${width}px`);
      await page.keyboard.press('Escape');
      if (width === 320) await page.screenshot({path: path.join(output, 'conversation-320.png')});
    }
    checks.push('280/320/400px layouts keep messages and composer within the viewport');

    const sendState = state => page.evaluate(value => { window.previewState = value; window.postMessage(value, '*'); }, state);
    const live = {...initial, mode: 'live', status: '로컬 수신 연결됨', selfId: '100', history: {floor:'0',loading:false}, messages: Array.from({length: 35}, (_, index) => ({
      ...initial.messages[index % 2], source: 'client', id: String(index), senderId: index % 2 ? '200' : '100', text: `메시지 ${index}\n${'긴 본문 확인 '.repeat(16)}`
    }))};
    live.roomPicker = {open: true, loading: false, rooms: [{id: live.messages[0].roomId, title: live.messages[0].roomTitle}], error: ''};
    await sendState(live);
    await page.locator('#room-list button').first().click();
    assert.equal(await page.evaluate(() => window.hostRequests.at(-1).type), 'selectRoom');
    live.activeRoomId = live.messages[0].roomId; live.roomPicker.open = false;
    await sendState(live);
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 35);
    assert.equal(await page.locator('.outgoing').count(), 18);
    await page.locator('#messages').evaluate(element => { element.scrollTop = 120; });
    const before = await page.locator('#messages').evaluate(element => element.scrollTop);
    live.messages.push({...live.messages[1], id: '35', text: '<img src=x onerror=alert(1)>\n한글 👋 ' + '가'.repeat(200)});
    await sendState(live);
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 36);
    assert.equal(await page.locator('#messages').evaluate(element => element.scrollTop), before);
    assert.equal(await page.locator('.message-body img').count(), 0);
    await page.locator('#messages').evaluate(element => { element.scrollTop = element.scrollHeight; });
    live.messages.push({...live.messages[1], id: '36', text: '하단에서 새 메시지 확인'});
    await sendState(live);
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 37);
    assert.ok(await page.locator('#messages').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2));
    await page.setViewportSize({width:280,height:900});
    assert.ok(await page.locator('.outgoing-row').evaluateAll(rows=>rows.every(row=>{
      const time=row.querySelector('time').getBoundingClientRect(),body=row.querySelector('.message-body').getBoundingClientRect(),reply=row.querySelector('.message-reply')?.getBoundingClientRect();
      return time.right<=body.left&&(!reply||reply.right<=body.left)&&time.left>=0&&body.right<=innerWidth;
    })),'Long outgoing messages keep reply and timestamp left of the bubble');
    await page.setViewportSize({width:400,height:900});
    checks.push('Live sender ID alignment, safe literal text, reading position and follow at bottom');

    live.activeRoomId = live.messages[0].roomId;
    live.canSend = true; live.sendingEnabled = true;
    await sendState(live);
    await page.waitForFunction(() => !document.getElementById('draft').disabled);
    await page.locator('[data-message-id="34"] .message-reply').click();
    assert.equal(await page.locator('#reply-title').textContent(),'나에게 답장');
    await page.locator('#cancel-reply').click();
    await page.locator('#draft').fill('합성 답장 👋');
    await page.locator('#draft').press('Enter');
    await page.waitForFunction(() => window.hostRequests.some(value => value.type === 'send'));
    const firstSend = await page.evaluate(() => window.hostRequests.find(value => value.type === 'send'));
    assert.equal(firstSend.text, '합성 답장 👋');
    assert.equal(firstSend.roomId, live.activeRoomId);
    assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement&&!e.disabled),true);
    await sendState({...live,sending:true,canSend:false});
    await page.waitForFunction(()=>document.getElementById('send').disabled);
    assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement&&!e.disabled),true);
    await sendState(live);
    await page.evaluate(requestId => window.postMessage({type: 'send-result', requestId, ok: false, error: '합성 전송 실패'}, '*'), firstSend.requestId);
    await page.waitForFunction(() => !document.getElementById('draft').disabled);
    assert.equal(await page.locator('#draft').inputValue(), firstSend.text);
    assert.equal(await page.locator('#status-dot').getAttribute('title'), '로컬 수신 연결됨 · 합성 전송 실패');
    assert.ok(await page.locator('#status-dot').evaluate(element => element.classList.contains('error')));
    assert.equal(await page.evaluate(() => window.hostRequests.filter(value => value.type === 'send').length), 1);
    await page.locator('#send').click();
    const secondSend = await page.evaluate(() => window.hostRequests.filter(value => value.type === 'send').at(-1));
    await page.evaluate(requestId => window.postMessage({type: 'send-result', requestId, ok: true}, '*'), secondSend.requestId);
    await page.waitForFunction(() => document.getElementById('draft').value === '');
    assert.equal(await page.locator('#status-dot').evaluate(element => element.classList.contains('error')), false);
    assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement),true);
    checks.push('Synthetic send request routes to the selected room, preserves failed drafts and clears confirmed drafts without automatic retry');

    live.messages.push({...live.messages[1],id:'40',kind:'card',text:'서비스 안내 카드',footer:'자세한 내용은 안내 페이지에서 확인하세요.',buttons:[{id:'0',label:'자세히 보기',url:'https://example.com/info'},{id:'1',label:'앱 열기'}]});
    live.messages.push({...live.messages[1],id:'41',kind:'reply',text:'이 내용에 대한 답장입니다.',reply:{id:'35',senderId:'200',text:'확인할 원문'}});
    live.messages.push({...live.messages[1],id:'42',senderId:'99887766',sender:'99887766',senderResolved:false,kind:'reply',text:'발신자 이름 조회 확인',reply:{id:'88888888',senderId:'88776655',text:'로드되지 않은 원문'}});
    await sendState(live);await page.locator('.reply-quote').first().waitFor();
    assert.equal(await page.locator('.card-action').count(),2);assert.equal(await page.locator('.card-action').nth(1).isDisabled(),true);
    assert.equal(await page.locator('[data-message-id="42"] .sender').textContent(),'알 수 없는 발신자');
    assert.equal(await page.locator('[data-message-id="42"] .reply-author').textContent(),'원문 작성자');
    assert.equal(await page.locator('[data-message-id="42"] .message-reply').getAttribute('aria-label'),'알 수 없는 발신자의 메시지에 답장');
    await page.locator('.card-action').first().click();
    assert.deepEqual(await page.evaluate(()=>window.hostRequests.filter(x=>x.type==='openButton').at(-1)),{type:'openButton',roomId:live.activeRoomId,messageId:'40',buttonId:'0'});
    await page.locator('[data-message-id="41"] .message-reply').click();
    assert.equal(await page.locator('#reply-draft').isVisible(),true);assert.equal(await page.locator('#draft').getAttribute('maxlength'),'500');
    await page.locator('#draft').fill('원문에 대한 답장');await page.locator('#send').click();
    const replySend=await page.evaluate(()=>window.hostRequests.filter(x=>x.type==='send').at(-1));
    assert.equal(replySend.replyTo,'41');assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement),true);
    await page.locator('#draft').fill('다음 메시지 작성 중');
    await page.evaluate(id=>window.postMessage({type:'send-result',requestId:id,ok:true},'*'),replySend.requestId);
    await page.waitForFunction(()=>document.getElementById('reply-draft').hidden);
    assert.equal(await page.locator('#draft').inputValue(),'다음 메시지 작성 중');assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement),true);
    await page.locator('[data-message-id="41"] .message-reply').click();await page.locator('#cancel-reply').click();
    assert.equal(await page.locator('#reply-draft').isVisible(),false);assert.equal(await page.locator('#draft').evaluate(e=>e===document.activeElement),true);
    await page.locator('[data-message-id="41"] .message-reply').click();
    await page.locator('#messages').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.screenshot({path:path.join(output,'reply-composer.png')});
    checks.push('Reply quote, card buttons, compose/cancel, exact reply ID, 500-character limit and input focus/draft retention through in-flight sends');

    const replyCases = [];
    for (const originalSender of ['100', '200']) {
      for (const replySender of ['100', '200']) {
        const id = String(60 + replyCases.length);
        const original = {...live.messages[0], id, senderId:originalSender, sender:originalSender === '100' ? '나' : '상대', text:`원문 ${originalSender} → ${replySender}`};
        const response = {...original, id:String(Number(id) + 1), senderId:replySender, sender:replySender === '100' ? '나' : '상대', kind:'reply', text:'댓글 본문', reply:{id, senderId:originalSender, text:original.text}};
        replyCases.push(original, response);
      }
    }
    await sendState({...live, messages:replyCases});
    await page.waitForFunction(()=>document.querySelectorAll('.reply-quote').length===4);
    for (const width of [280, 320, 400]) {
      await page.setViewportSize({width,height:900});
      for (let index=0;index<replyCases.length;index+=2) {
        const original=replyCases[index],response=replyCases[index+1];
        const source=page.locator(`[data-message-id="${original.id}"]`);
        const quote=page.locator(`[data-message-id="${response.id}"] .reply-quote`);
        assert.equal(await source.locator('.message-body').textContent(),original.text);
        assert.equal(await quote.locator('span').last().textContent(),original.text);
        assert.equal(await quote.locator('.reply-author').textContent(),original.sender);
        await quote.scrollIntoViewIfNeeded();
        assert.equal(await quote.isVisible(),true);
        assert.ok(await quote.evaluate(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>20&&r.left>=0&&r.right<=innerWidth;}));
        await quote.click();
        assert.equal(await source.evaluate(e=>e===document.activeElement),true);
      }
      if(width===400)await page.screenshot({path:path.join(output,'reply-authors.png')});
    }
    checks.push('Own and other authors retain original messages and reply quotes in all four sender combinations at 280/320/400px');

    const photo = {...live.messages[0], id:'90', kind:'image', text:'이미지'};
    const photoState = {...live, messages:[photo]};
    await sendState(photoState);
    const imageLabel = page.locator('.image-label'); await imageLabel.waitFor();
    await page.locator('#settings').focus(); await page.mouse.move(0,0);
    assert.equal(await imageLabel.textContent(),'이미지');
    assert.equal(await page.locator('.message-body img').count(),0);
    assert.equal(await page.locator('#image-preview-content').getAttribute('src'),null);
    const localPhoto = path.join(root,'.generated/research/image-reception/selected-thumbnail.jpg');
    const preview = fs.existsSync(localPhoto) ? {mime:'image/jpeg',data:fs.readFileSync(localPhoto).toString('base64')} : {mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPioAAAAASUVORK5CYII='};
    await imageLabel.hover();
    await page.waitForFunction(()=>window.hostRequests.some(r=>r.type==='image-preview'));
    const imageRequest = await page.evaluate(()=>window.hostRequests.filter(r=>r.type==='image-preview').at(-1));
    assert.equal(imageRequest.messageId,'90');
    await page.evaluate(value=>window.postMessage(value,'*'),{type:'image-preview-result',requestId:imageRequest.requestId,image:preview});
    await page.waitForFunction(()=>document.getElementById('image-preview-content').naturalWidth>0&&!document.getElementById('image-preview').hidden);
    await page.screenshot({path:path.join(output,'image-hover.png')});
    await sendState(photoState);
    await page.waitForFunction(()=>!document.getElementById('image-preview').hidden);
    for (const width of [280,320,400]) {
      await page.setViewportSize({width,height:650}); await imageLabel.hover();
      await page.waitForFunction(()=>!document.getElementById('image-preview').hidden);
      assert.ok(await page.locator('#image-preview').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
      await page.mouse.move(0,0); await page.waitForFunction(()=>document.getElementById('image-preview').hidden);
      assert.equal(await page.locator('#image-preview-content').getAttribute('src'),null);
    }
    await imageLabel.focus(); await page.waitForFunction(()=>!document.getElementById('image-preview').hidden);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#image-preview').isVisible(),false);
    await page.locator('#settings').focus(); await imageLabel.hover();
    await page.waitForFunction(()=>!document.getElementById('image-preview').hidden);
    await page.locator('#back').click(); assert.equal(await page.locator('#image-preview').isVisible(),false);
    await page.evaluate(value=>window.postMessage(value,'*'),{type:'image-preview-result',requestId:imageRequest.requestId,image:preview});
    assert.equal(await page.locator('#image-preview').isVisible(),false);
    await sendState(live);
    await page.evaluate(roomId=>window.postMessage({type:'openRoom',roomId},'*'),live.activeRoomId);
    await page.locator('#messages').waitFor();
    checks.push('Image label only in chat; hover/focus loads a local preview, viewport bounds, cache reuse, Escape/leave/navigation hide it and stale responses cannot reopen it');

    await page.locator('#back').click();
    assert.ok(await page.evaluate(() => window.hostRequests.some(value => value.type === 'rooms')));
    const choosing = {...live, canSend: false, roomPicker: {open: true, loading: true, rooms: [], error: ''}};
    await sendState(choosing);
    await page.waitForFunction(() => document.getElementById('refresh-rooms').disabled);
    assert.equal(await page.locator('#panel-title').textContent(), 'Chats');
    assert.equal(await page.locator('#messages').isVisible(), false);
    assert.equal(await page.locator('#refresh-rooms').isDisabled(), true);
    assert.equal(await page.locator('#room-search').evaluate(element => element === document.activeElement), true);
    const available = [{id: '123', title: '프로젝트 대화',lastMessageAt:'2026-11-17T01:00:00Z'}, {id: '456', title: '프로젝트 대화',unreadCount:3,lastMessageAt:'2026-11-17T00:00:00Z'},
      ...Array.from({length: 30}, (_, i) => ({id: String(1000 + i), title: `개발팀 ${i + 1} · ${'긴 이름 '.repeat(8)}`}))];
    choosing.roomPicker = {open: true, loading: false, rooms: available, error: ''};
    choosing.roomSort='unread';
    await sendState(choosing);
    await page.waitForFunction(() => document.querySelectorAll('#room-list button').length === 32);
    assert.equal(await page.locator('#room-list .room-id').count(),0);assert.equal(await page.locator('#room-list .unread-count').textContent(),'3');
    assert.equal(await page.locator('#room-list button').first().getAttribute('title'),'프로젝트 대화');
    for (const width of [280, 320, 400]) {
      await page.setViewportSize({width, height: 650});
      assert.ok(await page.evaluate(() => {
        const list = document.getElementById('room-list');
        const composer = document.querySelector('.composer');
        return document.documentElement.scrollWidth <= innerWidth && list.scrollWidth <= list.clientWidth &&
          list.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top;
      }), `Room picker overflow at ${width}px`);
    }
    await page.screenshot({path: path.join(output, 'chats.png')});
    await page.locator('#room-search').fill('프로젝트');
    assert.equal(await page.locator('#room-list button').count(), 2);
    await page.locator('#room-search').fill('456');
    assert.equal(await page.locator('#room-list button').count(), 0);
    await page.locator('#room-search').fill('프로젝트');
    await sendState({...choosing, warning: '합성 연결 경고'});
    assert.equal(await page.locator('#room-search').inputValue(), '프로젝트', 'Status updates preserve the search query');
    await page.locator('#room-list button').first().click();
    assert.deepEqual(await page.evaluate(() => window.hostRequests.filter(value => value.type === 'selectRoom').at(-1)), {type: 'selectRoom', roomId: '456'});
    await sendState({...choosing, busy: true});
    await page.waitForFunction(() => document.querySelector('#room-list button').disabled);
    assert.equal(await page.locator('#refresh-rooms').isDisabled(), true);
    const connected = {...live, activeRoomId: '456', activeRoomTitle: '프로젝트 대화', messages: [], roomPicker: {...choosing.roomPicker, open: false}};
    await sendState(connected);
    await page.locator('#messages').waitFor();
    assert.equal(await page.locator('#panel-title').textContent(), '프로젝트 대화');
    assert.equal(await page.locator('#draft').isDisabled(), false, 'Empty connected rooms can compose');
    assert.ok(await page.locator('#status-dot').evaluate(element => element.classList.contains('connected')));
    await page.locator('#back').click();
    await page.locator('#room-list button').first().click();
    assert.deepEqual(await page.evaluate(() => window.hostRequests.filter(value => value.type === 'selectRoom').at(-1)), {type: 'selectRoom', roomId: '123'});
    await sendState({...choosing, roomPicker: {...choosing.roomPicker, rooms: []}});
    await page.waitForFunction(() => document.getElementById('room-list-status').textContent.includes('새로고침'));
    await sendState({...choosing, roomPicker: {...choosing.roomPicker, rooms: [], error: '합성 조회 실패'}});
    await page.waitForFunction(() => document.getElementById('room-list-status').textContent === '합성 조회 실패');
    await page.locator('#refresh-rooms').click();
    assert.equal(await page.evaluate(() => window.hostRequests.at(-1).type), 'rooms');
    await sendState(choosing);
    await page.waitForFunction(() => document.querySelectorAll('#room-list button').length === 32);
    await page.locator('#room-search').fill('검색 결과 없음');
    assert.equal(await page.locator('#room-list button').count(), 0);
    assert.equal(await page.locator('#room-list-status').textContent(), '검색 결과가 없습니다.');
    checks.push('Chats search and room selection through the back arrow, loading/empty/error/retry states and 280/320/400px scrolling');

    await page.setViewportSize({width: 400, height: 900});
    await page.goto('http://local-chat.preview/?theme=light');
    await page.locator('#room-list button').first().click();
    await page.locator('#settings').focus();
    await page.mouse.move(0, 0);
    await page.screenshot({path: path.join(output, 'conversation-light.png')});
    await sendState({type: 'state', mode: 'idle', status: '연결 안 됨', selfId: '', messages: []});
    await page.locator('#room-list-status').waitFor();
    assert.equal(await page.locator('#messages').isVisible(), false);
    checks.push('Light theme render and cleared connection returns to empty home');
    assert.deepEqual(errors, [], 'Browser errors or CSP violations');
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({timestamp: new Date().toISOString(), browser: await browser.version(), executablePath, host: 'simulated VS Code API', data: 'synthetic messages; local thumbnail when available', checks, errors}, null, 2) + '\n');
    console.log(JSON.stringify({passed: checks.length, checks, output}, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
