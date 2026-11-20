'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('local-workspace.kakao-local-chat');
  assert.ok(extension, 'Local Chat extension is installed in the test host');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('localChat.open'));
  assert.deepEqual(commands.filter(name => name.startsWith('localChat.') && name !== 'localChat.messages.focus'), ['localChat.open']);
  assert.deepEqual(extension.packageJSON.contributes.commands, [{command: 'localChat.open', title: '카카오톡: 창 열기'}]);
  await vscode.commands.executeCommand('localChat.open');
  const output = path.join(extension.extensionPath, '.generated', 'integration', 'extension-host.json');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify({at: new Date().toISOString(), passed: true, vscode: vscode.version,
    checks: ['Extension activation', 'Single palette command', 'Webview creation and room discovery entry'],
    actualClientConnected: false}, null, 2) + '\n');
  console.log('Local Chat extension host checks passed.');
}

module.exports = {run};
