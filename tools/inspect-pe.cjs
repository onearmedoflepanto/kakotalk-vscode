'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

// Inspect the installed file without loading it or attaching to its process.
function inspectPe(bytes) {
  function range(offset, count) {
    if (!Number.isInteger(offset) || offset < 0 || offset + count > bytes.length) {
      throw new Error('PE file contains an invalid offset.');
    }
    return offset;
  }
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  if (u16(0) !== 0x5a4d) throw new Error('Not a PE file: DOS signature missing.');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error('Not a PE file: PE signature missing.');
  const machine = u16(pe + 4);
  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  range(optional, optionalSize);
  const magic = u16(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported PE optional header.');
  const is64 = magic === 0x20b;
  const directoryOffset = is64 ? 112 : 96;
  if (optionalSize < directoryOffset) throw new Error('Truncated optional header.');
  const directoryCount = u32(optional + directoryOffset - 4);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = optional + optionalSize + i * 40;
    range(at, 40);
    sections.push({
      name: bytes.toString('ascii', at, at + 8).replace(/\0.*$/, ''),
      rva: u32(at + 12), rawSize: u32(at + 16), rawOffset: u32(at + 20)
    });
  }
  function fileOffset(rva) {
    const headerSize = u32(optional + 60);
    if (rva < headerSize) return range(rva, 1);
    const section = sections.find(s => rva >= s.rva && rva - s.rva < s.rawSize);
    if (!section) throw new Error('RVA does not refer to file-backed data.');
    return range(section.rawOffset + rva - section.rva, 1);
  }
  function cstring(rva) {
    const at = fileOffset(rva);
    const end = bytes.indexOf(0, at);
    if (end < at || end - at > 4096) throw new Error('Invalid import string.');
    return bytes.toString('ascii', at, end);
  }
  const imports = [];
  if (directoryCount > 1 && optionalSize >= directoryOffset + 16) {
    const importRva = u32(optional + directoryOffset + 8);
    const importSize = u32(optional + directoryOffset + 12);
    if (importRva && importSize) {
      for (let i = 0; i < Math.min(Math.floor(importSize / 20), 4096); i++) {
        const at = fileOffset(importRva + i * 20);
        range(at, 20);
        const nameRva = u32(at + 12);
        if (!nameRva) break;
        const thunkRva = u32(at) || u32(at + 16);
        const functions = [];
        if (thunkRva) {
          for (let j = 0; j < 65536; j++) {
            const thunk = fileOffset(thunkRva + j * (is64 ? 8 : 4));
            range(thunk, is64 ? 8 : 4);
            const value = is64 ? bytes.readBigUInt64LE(thunk) : BigInt(u32(thunk));
            if (value === 0n) break;
            const ordinalFlag = is64 ? 0x8000000000000000n : 0x80000000n;
            if (value & ordinalFlag) functions.push('#' + (value & 0xffffn));
            else {
              if (value > 0xffffffffn) throw new Error('Invalid import RVA.');
              functions.push(cstring(Number(value) + 2));
            }
          }
        }
        imports.push({module: cstring(nameRva), functions});
      }
    }
  }
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    architecture: ({0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64'})[machine] || 'unknown',
    imageFormat: is64 ? 'PE32+' : 'PE32', sections: sections.map(s => s.name), imports,
    limitation: 'Static imports only; dynamic imports and internal message functions are not identified.'
  };
}

if (require.main === module) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('Usage: node tools/inspect-pe.cjs <exe> [--summary]');
    const info = inspectPe(fs.readFileSync(file));
    if (process.argv.includes('--summary')) {
      info.imports = info.imports.map(item => ({
        module: item.module,
        candidates: item.functions.filter(name => /DrawText|TextOut|GdipDrawString|DirectWrite|DWrite|SetWindowText|SetWindowsHook|RichEdit|CreateWindow/i.test(name))
      }));
    }
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {inspectPe};
