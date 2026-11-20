'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {once} = require('node:events');
const {CollectorClient} = require('../src/collector-client.cjs');
const {resolveWorker} = require('../src/runtime.cjs');
const {MessageStore} = require('../src/protocol.cjs');

async function main() {
  const roomId = process.argv[2];
  const waitForDisplay = process.argv.includes('--wait-for-display');
  assert.match(roomId || '', /^[1-9][0-9]{0,19}$/);
  const root = path.resolve(__dirname, '..');
  const client = new CollectorClient(root);
  const store = new MessageStore();
  const diagnostics = [];
  const statuses = [];
  client.on('message', value => store.add(value));
  client.on('status', value => statuses.push(value));
  client.on('diagnostic', value => {
    diagnostics.push({status: value.status, snapshotState: value.snapshotState, message: value.status === 'error' ? value.message : undefined, cleanup: value.cleanup, counters: value.counters});
  });
  const result = {at: new Date().toISOString(), roomId, networkCallsByValidation: false, actualSendTested: false};
  try {
    const rooms = await client.discover();
    assert.ok(rooms.some(room => room.id === roomId), 'Selected room must be discoverable');
    result.discoveredRoomCount = rooms.length;
    const workerPath = await resolveWorker({root: path.join(root, '.generated', 'releases')});
    const ended = once(client, 'ended');
    await client.connect({workerPath, roomId, duration: waitForDisplay ? 45 : 5, includeExisting: true});
    console.log('Collector ready; observing the selected room.');
    result.termination = (await ended)[0];
    assert.equal(result.termination.clean, true);
    assert.equal(result.termination.code, 0);
    assert.ok(store.snapshot().length > 0, 'A selected room message must reach the extension store');
    result.messages = store.snapshot().map(value => ({id: value.id, roomId: value.roomId, senderId: value.senderId,
      senderResolved: value.senderResolved, observation: value.observation, timestampKind: value.timestampKind,
      textCharacters: value.text.length, textSha256: createHash('sha256').update(value.text).digest('hex')}));
    for (const value of result.messages) {
      assert.equal(value.roomId, roomId);
      assert.equal(value.timestampKind, 'observed');
    }
    // Verify a second attach followed by parent-requested shutdown, without sending a message.
    await client.connect({workerPath, roomId, duration: 60});
    result.explicitStop = await client.stop();
    assert.equal(result.explicitStop.clean, true);
    result.passed = true;
  } finally {
    await client.dispose();
    result.statuses = statuses;
    result.diagnostics = diagnostics;
    const output = path.join(root, '.generated', 'integration', 'client-to-store.json');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({passed: result.passed || false, messageCount: result.messages?.length || 0, cleanup: result.termination?.clean, explicitStop: result.explicitStop?.clean, output}, null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
