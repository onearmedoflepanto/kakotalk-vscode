#requires -Version 5.1
[CmdletBinding()]
param([string]$ZipPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = Join-Path $projectRoot '.generated\releases'
$work = Join-Path $releaseRoot ('.verify-' + [guid]::NewGuid().ToString('N'))
$script:assertions = 0
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}

try {
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if (-not $ZipPath) { $ZipPath = Join-Path $releaseRoot "local-chat-$version-win32-x64.zip" }
    $ZipPath = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
    $checksum = [IO.File]::ReadAllText($ZipPath + '.sha256').Split(' ')[0]
    $stream = [IO.File]::OpenRead($ZipPath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    Assert ($checksum -match '^[0-9a-f]{64}$' -and $hash -ceq $checksum) 'Release checksum mismatch.'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $bundle = Join-Path $work 'package [release] & test'
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $bundle)
    $files = @(Get-ChildItem -LiteralPath $bundle -File)
    Assert ($files.Count -eq 3 -and $files.Name -contains 'install.ps1' -and $files.Name -contains 'README.md') 'Unexpected release contents.'
    $vsix = Join-Path $bundle "kakao-local-chat-$version-win32-x64.vsix"
    $archive = [IO.Compression.ZipFile]::OpenRead($vsix)
    try {
        $entries = @($archive.Entries.FullName)
        Assert (@($entries | Where-Object { $_ -match '\.(py|pyc)$|node_modules/|/tests/|/\.generated/|python\.exe$' }).Count -eq 0) 'Development files are present in the VSIX.'
        Assert ($entries -contains 'extension/bin/local-chat-worker.exe') 'Worker executable is missing.'
        Assert (($entries -contains 'extension/licenses/Python.txt') -and ($entries -contains 'extension/licenses/Frida.txt') -and ($entries -contains 'extension/licenses/PyInstaller.txt')) 'Runtime licenses are missing.'
    } finally { $archive.Dispose() }
    $extract = Join-Path $work 'vsix'
    [IO.Compression.ZipFile]::ExtractToDirectory($vsix, $extract)
    $app = Join-Path $extract 'extension'
    $manifest = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($manifest.version -eq $version -and $manifest.publisher -eq 'local-workspace' -and $manifest.name -eq 'kakao-local-chat') 'Packaged manifest mismatch.'
    Add-Type -Path (Join-Path $app 'tools/ClientMessageProbe.cs')
    $builds = Get-Content -LiteralPath (Join-Path $projectRoot 'tools/client-builds.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($build in $builds.PSObject.Properties) {
        $tables = [LocalChatResearch.ClientMessageProbe]::BuildTableRvas($build.Name)
        $expected = @($build.Value.tables.PSObject.Properties | ForEach-Object { [Convert]::ToUInt64($_.Value.Substring(2), 16) })
        Assert (($tables -join ',') -ceq ($expected -join ',')) ("Client and worker tables differ: " + $build.Value.version)
    }
    $unsupportedRejected = $false
    try { [LocalChatResearch.ClientMessageProbe]::BuildTableRvas(('0' * 64)) | Out-Null }
    catch { $unsupportedRejected = $_.Exception.GetBaseException().Message -eq 'Unsupported client build.' }
    Assert $unsupportedRejected 'Unsupported client build was accepted.'
    $tokens = $null; $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $bundle 'install.ps1'), [ref]$tokens, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) 'The installation script has syntax errors.'

    $harness = @'
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = process.argv[2];
const executable = path.join(root, 'bin', 'local-chat-worker.exe');
process.env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
process.env.PYTHONHOME = path.join(root, 'missing-python');
process.env.PYTHONPATH = path.join(root, 'missing-modules');
const run = (args, input = '') => spawnSync(executable, args, {input, encoding:'utf8', windowsHide:true, timeout:30000});
(async () => {
  const probe = run(['check']);
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {protocol:1,bits:64,frida:'17.26.3',frozen:true});
  const help = run(['collect','--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /metadata-stdin/);
  const failedReply = run(['reply'], '{}\n');
  assert.equal(failedReply.status, 1, failedReply.stderr);
  assert.equal(JSON.parse(failedReply.stdout).code, 'REPLY_PREPARE_FAILED');
  assert.equal(run(['unknown']).status, 2);
  const {resolveWorker} = require(path.join(root, 'src/runtime.cjs'));
  const workerPath = await resolveWorker({root});
  assert.equal(workerPath, executable);
  const {CollectorClient} = require(path.join(root, 'src/collector-client.cjs'));
  const collector = new CollectorClient(root);
  await assert.rejects(collector.launch({workerPath, metadata:{roomId:'123'}, duration:1}), /Unsupported metadata build/);
  await collector.dispose();
  const {ReplyClient} = require(path.join(root, 'src/reply-client.cjs'));
  const reply = new ReplyClient(root);
  await assert.rejects(reply.prepare({pid:0,roomId:'123',roomTitle:'fixture',replyTo:{id:'1',senderId:'2'}},workerPath), error => error.code === 'REPLY_PREPARE_FAILED');
  await reply.stop();
  console.log(JSON.stringify({passed:true,assertions:10}));
})().catch(error => {console.error(error);process.exitCode=1;});
'@
    $harnessPath = Join-Path $work 'packaged-host.cjs'
    [IO.File]::WriteAllText($harnessPath, $harness, [Text.UTF8Encoding]::new($false))
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $result = & $node $harnessPath $app
    if ($LASTEXITCODE -ne 0) { throw 'The packaged host integration failed.' }
    $result = $result | ConvertFrom-Json
    Assert ($result.passed -and $result.assertions -eq 10) 'The packaged host assertions did not complete.'
    $script:assertions += $result.assertions
    Write-Host "Package integration passed: $script:assertions assertions"
} finally {
    $resolvedWork = [IO.Path]::GetFullPath($work)
    $resolvedRoot = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
    if (-not $resolvedWork.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedWork) -notmatch '^\.verify-[0-9a-f]{32}$') {
        throw 'Refusing to remove a verification directory outside the release folder.'
    }
    if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
