'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validateImagePreview} = require('../src/image-preview.cjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPioAAAAASUVORK5CYII=';
test('preview reads dimensions from bytes and discards unrelated native metadata', () => {
  const result = validateImagePreview({mime: 'image/png', data: png, width: 900, url: 'https://example.com/image'});
  assert.equal(result.width, 1); assert.equal(result.height, 1); assert.equal(result.url, undefined);
  const jpeg = Buffer.from('ffd8ffe000040000ffc00011080280016803011100021100031100ffd9', 'hex');
  assert.equal(validateImagePreview({mime: 'image/jpeg', data: jpeg.toString('base64')}).width, 360);
});
test('preview rejects remote sources, SVG, corrupted base64, oversized images and forged dimensions', () => {
  for (const value of [{mime:'image/svg+xml',data:png},{mime:'image/png',data:'https://example.com/a.png'},{mime:'image/png',data:png+'\n'},{mime:'image/jpeg',data:png},{mime:'image/png',data:Buffer.alloc(1048577).toString('base64')}]) assert.throws(() => validateImagePreview(value));
  const bytes = Buffer.from(png, 'base64'); bytes.writeUInt32BE(100000, 16);
  assert.throws(() => validateImagePreview({mime:'image/png', data:bytes.toString('base64')}));
  assert.throws(() => validateImagePreview({mime:'image/jpeg',data:Buffer.from('ffd8ffe0ffff'+'00'.repeat(24),'hex').toString('base64')}));
});
