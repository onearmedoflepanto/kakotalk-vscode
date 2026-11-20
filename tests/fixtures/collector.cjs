'use strict';
const readline = require('node:readline');
let metadata, timer;
const input = readline.createInterface({input: process.stdin});
const stop = () => {
  clearTimeout(timer);
  process.stderr.write(JSON.stringify({status: 'stopped', reason: 'parent-disconnected', cleanup: {hookRestored: true, scriptUnloaded: true, sessionDetached: true}}) + '\n');
  input.close(); process.exitCode = 0;
};
input.on('line', line => {
  const value = JSON.parse(line);
  if (!metadata) {
    metadata = value;
    process.stderr.write(JSON.stringify({status: 'ready', roomTitle: '테스트'}) + '\n');
    if (process.argv[2] === 'invalid') process.stdout.write('{invalid}\n');
    else {
      const message = {version: 1, type: 'message', source: 'client', id: '9876543210987654321', roomId: metadata.roomId, roomTitle: '테스트',
        sender: '작성자', senderId: '123', text: '한글 👋\n본문', timestamp: new Date().toISOString(), timestampKind: 'observed', observation: 'cache-snapshot'};
      const bytes = Buffer.from(JSON.stringify(message) + '\n');
      for (let i = 0; i < bytes.length; i++) process.stdout.write(bytes.subarray(i, i + 1));
    }
    timer = setTimeout(stop, 5000);
  } else if (value.command === 'history') {
    const message={version:1,type:'message',source:'client',id:'90',roomId:metadata.roomId,roomTitle:'테스트',sender:'작성자',senderId:'123',text:'이전 본문',timestamp:new Date().toISOString(),observation:'cache-snapshot'};
    if (value.params.before === '2') message.roomId='999';
    if (value.params.before !== '3') process.stderr.write(JSON.stringify({status:'history',requestId:value.id,messages:[message]})+'\n');
  } else if (value.command === 'stop') stop();
});
input.on('close', () => { clearTimeout(timer); });
