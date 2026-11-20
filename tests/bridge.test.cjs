'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {once} = require('node:events');
const {CollectorClient} = require('../src/collector-client.cjs');

test('private child stream delivers split UTF-8 with identity and stops cleanly', {timeout: 10000}, async t => {
  const client = new CollectorClient(path.resolve(__dirname, '..'));
  t.after(() => client.dispose());
  const message = once(client, 'message');
  await client.launch({program: process.execPath, args: [path.join(__dirname, 'fixtures', 'collector.cjs')], metadata: {roomId: '123'}});
  const [value] = await message;
  assert.equal(value.text, '한글 👋\n본문');
  assert.equal(value.id, '9876543210987654321');
  assert.equal(value.timestampKind, 'observed');
  assert.equal(value.observation, 'cache-snapshot');
  assert.equal((await client.stop()).clean, true);
});

test('invalid child output terminates collection instead of displaying a partial event', {timeout: 10000}, async t => {
  const client = new CollectorClient(path.resolve(__dirname, '..'));
  t.after(() => client.dispose());
  const messages = [];
  client.on('message', value => messages.push(value));
  const ended = once(client, 'ended');
  await client.launch({program: process.execPath, args: [path.join(__dirname, 'fixtures', 'collector.cjs'), 'invalid'], metadata: {roomId: '123'}});
  const [result] = await ended;
  assert.match(result.error, /형식 오류/);
  assert.deepEqual(messages, []);
});
