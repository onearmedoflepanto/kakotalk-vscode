'use strict';

const paths = {
  back: '<path d="m10 4-4 4 4 4M6 8h7"/>',
  settings: '<path d="m6.5 1-.5 1.5-1.5.9-1.6-.3-1.5 2.6 1.1 1.2v1.8l-1.1 1.2 1.5 2.6 1.6-.3 1.5.9.5 1.5h3l.5-1.5 1.5-.9 1.6.3 1.5-2.6-1.1-1.2V6.9l1.1-1.2-1.5-2.6-1.6.3-1.5-.9L9.5 1Z"/><circle cx="8" cy="7.8" r="2.2"/>',
  up: '<path d="M8 13V3m-4 4 4-4 4 4"/>',
  menu: '<path d="M3 4h10M3 8h10M3 12h10"/>',
  refresh: '<path d="M13 6a5 5 0 1 0 0 4M13 2v4H9"/>'
};
const icon = name => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const attribute = value => String(value).replace(/[&"<>]/g, char => ({'&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'}[char]));

function renderWebview({cssUri, scriptUri, cspSource, nonce}) {
  return `<!doctype html>
<html lang="ko"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${attribute(cspSource)}; script-src 'nonce-${attribute(nonce)}';">
  <link rel="stylesheet" href="${attribute(cssUri)}"><title>Local Chat</title>
</head><body>
  <header class="panel-header">
    <button id="back" class="icon-button" aria-label="대화 목록으로" title="대화 목록으로" hidden>${icon('back')}</button>
    <h1 id="panel-title" class="panel-title">Chats</h1>
    <nav class="toolbar" aria-label="채팅 도구">
      <button id="settings" class="icon-button" aria-label="Local Chat 설정" title="Local Chat 설정">${icon('settings')}</button>
    </nav>
  </header>
  <section id="home" class="home" aria-label="Chats">
    <div class="room-search-row">
      <input id="room-search" type="search" placeholder="채팅방 이름 검색" aria-label="채팅방 이름 검색" autocomplete="off">
      <button id="refresh-rooms" class="icon-button" aria-label="채팅방 새로고침" title="채팅방 새로고침">${icon('refresh')}</button>
    </div>
    <p id="room-list-status" class="room-list-status" role="status" hidden></p>
    <div id="room-list" class="room-list" aria-label="채팅방 목록"></div>
  </section>
  <main id="messages" class="messages" aria-label="대화 내용" tabindex="0" hidden></main>
  <footer class="composer-footer">
    <div class="composer">
      <div id="reply-draft" class="reply-draft" hidden><div><strong id="reply-title"></strong><span id="reply-text"></span></div><button id="cancel-reply" class="icon-button" aria-label="답장 취소" title="답장 취소">×</button></div>
      <textarea id="draft" disabled maxlength="2000" aria-label="메시지 입력" placeholder="메시지 입력" rows="2"></textarea>
      <div class="composer-controls">
        <button id="composer-menu" class="icon-button" aria-label="메뉴" title="메뉴" aria-expanded="false" aria-controls="actions-menu">${icon('menu')}</button>
        <span id="selected-room" class="selected-room">Local Chat</span>
        <span id="status-dot" class="status-dot" role="status" aria-label="연결 안 됨" title="연결 안 됨" tabindex="0"></span>
        <button id="send" class="icon-button send" disabled aria-label="PC카톡에서 메시지 보내기" title="PC카톡 창에서 보내기 · Enter">${icon('up')}</button>
      </div>
      <div id="actions-menu" class="popup actions-menu" hidden>
        <button id="disconnect" class="popup-action">연결 끊기</button>
        <button id="toggleSending" class="popup-action">답장 기능 켜기</button>
        <button id="logs" class="popup-action">연결 로그 보기</button>
      </div>
    </div>
  </footer>
  <div id="image-preview" class="image-preview" role="tooltip" hidden><span id="image-preview-status" role="status"></span><img id="image-preview-content" alt="이미지 미리보기" hidden></div>
  <script nonce="${attribute(nonce)}" src="${attribute(scriptUri)}"></script>
</body></html>`;
}

module.exports = {renderWebview};
