'use strict';

const MAX_IMAGE_BYTES = 1024 * 1024;
function validateImagePreview(value) {
  if (!value || !['image/jpeg', 'image/png'].includes(value.mime) || typeof value.data !== 'string' ||
      value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('Invalid image preview.');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value.data) throw new Error('Invalid image bytes.');
  let width, height;
  if (value.mime === 'image/png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG header.');
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += size;
    }
  }
  if (!(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16000000)) throw new Error('Invalid preview dimensions.');
  return Object.freeze({mime: value.mime, data: value.data, width, height});
}
module.exports = {validateImagePreview};
