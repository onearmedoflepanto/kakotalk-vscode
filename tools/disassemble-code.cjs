'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const inputPath = path.resolve(process.argv[2]);
const evidenceRoot = path.resolve(__dirname, '../.generated/research/message-validation');
const relative = path.relative(evidenceRoot, inputPath);
if (relative.startsWith('..') || path.isAbsolute(relative) || !inputPath.endsWith('.json')) {
  throw new Error('Input must be a JSON code sample under .generated/research/message-validation.');
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
if (input.Mode !== 'Code' || !/^(?:[0-9A-Fa-f]{2})+$/.test(input.Result.Hex)) throw new Error('Expected a code sample.');
const code = Buffer.from(input.Result.Hex, 'hex');
if (code.length > 16384) throw new Error('Code samples are limited to 16 KiB.');
const header = Buffer.alloc(60);
header.writeUInt16LE(0x8664, 0);
header.writeUInt16LE(1, 2);
header.write('.text', 20);
header.writeUInt32LE(code.length, 36);
header.writeUInt32LE(60, 40);
header.writeUInt32LE(0x60000020, 56);
const output = inputPath.replace(/\.json$/, '.obj');
fs.writeFileSync(output, Buffer.concat([header, code]));
const dumpbin = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\dumpbin.exe';
process.stdout.write(`Source RVA: ${input.Result.Rva}; addresses below are offsets from this RVA.\n`);
process.stdout.write(execFileSync(dumpbin, ['/nologo', '/disasm:bytes', output], { encoding: 'utf8' }));
