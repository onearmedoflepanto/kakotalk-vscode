'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {runProcess} = require('./collector-client.cjs');

function runtimeWorker(root) { return path.join(root, 'bin', 'local-chat-worker.exe'); }
const validations = new Map();

async function validateWorker(executable) {
  const result = JSON.parse(await runProcess(executable, ['check'], {timeout: 20000}));
  if (result.protocol !== 1 || result.bits !== 64 || result.frida !== '17.26.3' || result.frozen !== true) throw new Error('확장에 포함된 실행 환경을 확인하지 못했습니다. 배포 패키지로 다시 설치하세요.');
  return executable;
}

async function resolveWorker({root}) {
  const executable = runtimeWorker(root);
  if (!fs.existsSync(executable)) throw new Error('확장의 실행 파일이 없습니다. 배포 패키지로 다시 설치하세요.');
  if (!validations.has(executable)) validations.set(executable, validateWorker(executable).catch(() => {
    validations.delete(executable);
    throw new Error('확장에 포함된 실행 환경을 시작하지 못했습니다. 배포 패키지로 다시 설치하세요.');
  }));
  return validations.get(executable);
}
module.exports = {resolveWorker, validateWorker, runtimeWorker};
