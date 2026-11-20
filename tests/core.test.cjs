'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {MAX_FRAME, MessageDecoder, MessageStore, validateMessage} = require('../src/protocol.cjs');
const {sampleMessages} = require('./fixtures/messages.cjs');
const {inspectPe} = require('../tools/inspect-pe.cjs');

const example = () => ({...sampleMessages()[0], text: '한글 👋\n두 번째 줄 <script>alert(1)</script>'});
const encode = value => Buffer.from(JSON.stringify(value) + '\n');

test('UTF-8 and JSON framing survive a split at every byte', () => {
  const value = example();
  const bytes = encode(value);
  for (let split = 0; split <= bytes.length; split++) {
    const received = [];
    const decoder = new MessageDecoder(event => received.push(event));
    decoder.push(bytes.subarray(0, split));
    decoder.push(bytes.subarray(split));
    decoder.finish();
    assert.deepEqual(received, [value]);
  }
});

test('multiple events and CRLF are accepted without changing the message text', () => {
  const received = [];
  const decoder = new MessageDecoder(event => received.push(event));
  const messages = sampleMessages();
  decoder.push(Buffer.from(messages.map(value => JSON.stringify(value)).join('\r\n') + '\r\n'));
  decoder.finish();
  assert.deepEqual(received, messages);
});

test('invalid framing, UTF-8 and oversized events stop decoding', () => {
  for (const bytes of [Buffer.from('{broken}\n'), Buffer.from([0xff, 10]), Buffer.alloc(MAX_FRAME + 1, 65)]) {
    const decoder = new MessageDecoder(() => assert.fail('Invalid event was accepted.'));
    assert.throws(() => decoder.push(bytes));
    assert.throws(() => decoder.push(encode(example())), /closed/);
  }
  const decoder = new MessageDecoder(() => {});
  decoder.push(Buffer.from('{"version":'));
  assert.throws(() => decoder.finish(), /during/);
});

test('message schema rejects missing routing identity and invalid dates', () => {
  for (const patch of [{roomId: ''}, {sender: null}, {id: ''}, {version: 2}, {source: 'unknown'}, {timestamp: 'tomorrow'}, {text: 'x'.repeat(16385)}]) {
    assert.throws(() => validateMessage({...example(), ...patch}));
  }
  assert.equal('privateBuffer' in validateMessage({...example(), privateBuffer: 'not retained'}), false);
});

test('deduplication keeps identical texts and equal IDs in separate rooms', () => {
  const store = new MessageStore();
  const value = example();
  assert.equal(store.add(value), true);
  assert.equal(store.add(value), false);
  assert.equal(store.add({...value, id: 'another'}), true);
  assert.equal(store.add({...value, roomId: 'another-room'}), true);
  assert.equal(store.snapshot().length, 3);
});

test('optional sender identity survives decoding without coercing large numeric IDs', () => {
  const value = {...example(), senderId: '9876543210987654321'};
  const received = [];
  new MessageDecoder(event => received.push(event)).push(encode(value));
  assert.equal(received[0].senderId, value.senderId);
  const legacy = {...value};
  delete legacy.senderId;
  assert.equal('senderId' in validateMessage(legacy), false);
  for (const senderId of [null, '', 123, 'x'.repeat(257)]) {
    assert.throws(() => validateMessage({...value, senderId}));
  }
});

test('bounded storage evicts old identities and clears all retained events', () => {
  const store = new MessageStore(2);
  for (const value of sampleMessages()) store.add(value);
  assert.deepEqual(store.snapshot().map(value => value.id), sampleMessages().slice(-2).map(value => value.id));
  store.clear();
  assert.deepEqual(store.snapshot(), []);
  assert.equal(store.add(sampleMessages()[0]), true);
});

test('PE inspection reads architecture and rejects truncated or non-PE bytes', () => {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  assert.equal(inspectPe(bytes).architecture, 'x64');
  assert.equal(inspectPe(bytes).sha256.length, 64);
  assert.throws(() => inspectPe(Buffer.from('not executable')));
  assert.throws(() => inspectPe(bytes.subarray(0, 200)));
});
