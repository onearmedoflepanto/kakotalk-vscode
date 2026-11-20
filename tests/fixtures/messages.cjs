'use strict';

// Synthetic records for development checks; excluded from the extension package.
function sampleMessages() {
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  return [
    {id:'1',roomId:'701',roomTitle:'채팅 패널 디자인',sender:'나',senderId:'100',timestamp:ago(62),text:'채팅 화면 확인\n한글과 여러 줄 메시지입니다.'},
    {id:'2',roomId:'701',roomTitle:'채팅 패널 디자인',sender:'지수',senderId:'200',timestamp:ago(60),text:'메시지 표시를 확인합니다.\n\n• 긴 본문 줄바꿈\n• 이름과 시간 표시\n• 좁은 화면의 입력창\n\n여러 줄 본문과 메뉴를 검사합니다.'},
    {id:'3',roomId:'702',roomTitle:'이번 주 코드 리뷰',sender:'민수',senderId:'300',timestamp:ago(180),text:'리뷰할 항목을 정리했어요.'},
    {id:'4',roomId:'703',roomTitle:'아이디어 메모',sender:'나',senderId:'100',timestamp:ago(300),text:'검사용 합성 메시지입니다.'},
    {id:'5',roomId:'704',roomTitle:'팀 대화',sender:'지수',senderId:'200',timestamp:ago(1440),text:'다음 회의는 수요일 오후 2시예요.'}
  ].map(value => ({version:1,type:'message',source:'client',...value}));
}

module.exports = {sampleMessages};
