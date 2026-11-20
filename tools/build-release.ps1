#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PythonPath = 'python.exe',
    [string]$VscePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = Join-Path $projectRoot '.generated\releases'
$stage = Join-Path $releaseRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $stage 'extension'
$bundle = Join-Path $stage 'bundle'

try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $python = (Get-Command $PythonPath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if (-not $VscePath) { $VscePath = Join-Path $projectRoot 'node_modules\@vscode\vsce\vsce' }
    if (-not (Test-Path -LiteralPath $VscePath -PathType Leaf)) { throw 'VSCE is missing. Run npm ci before building.' }
    $vsce = (Resolve-Path -LiteralPath $VscePath).ProviderPath
    $buildInfo = & $python -B -c "import sys,json,struct,frida,PyInstaller; from pathlib import Path; print(json.dumps(dict(bits=struct.calcsize('P')*8,frida=frida.__version__,pyinstaller=PyInstaller.__version__,base=sys.base_prefix,site=str(Path(frida.__file__).parent.parent))))"
    if ($LASTEXITCODE -ne 0) { throw 'Install tools/requirements-build.txt in the selected Python environment before building.' }
    $buildInfo = $buildInfo | ConvertFrom-Json
    if ($buildInfo.bits -ne 64 -or $buildInfo.frida -ne '17.26.3' -or $buildInfo.pyinstaller -ne '6.22.3') {
        throw 'The build requires Python x64, Frida 17.26.3 and PyInstaller 6.22.3.'
    }
    $manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = [version]$manifest.version
    $vsixName = "kakao-local-chat-$version-win32-x64.vsix"
    $zipPath = Join-Path $releaseRoot "local-chat-$version-win32-x64.zip"
    $null = New-Item -ItemType Directory -Path $app, $bundle -Force
    foreach ($item in @('package.json', 'README.md', '.vscodeignore', 'src', 'media', 'tools')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $app -Recurse
    }
    $bin = Join-Path $app 'bin'
    $buildArgs = @('-B', '-m', 'PyInstaller', '--noconfirm', '--onefile', '--console', '--noupx',
        '--name', 'local-chat-worker', '--distpath', $bin, '--workpath', (Join-Path $stage 'build'),
        '--specpath', $stage, '--collect-all', 'frida', '--copy-metadata', 'frida',
        '--add-data', ((Join-Path $projectRoot 'tools\collector\agent.js') + ':collector'),
        '--add-data', ((Join-Path $projectRoot 'tools\reply-agent.js') + ':.'),
        '--add-data', ((Join-Path $projectRoot 'tools\client-builds.json') + ':.'),
        (Join-Path $projectRoot 'tools\worker.py'))
    & $python @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Worker compilation failed.' }
    $worker = Join-Path $bin 'local-chat-worker.exe'
    $probe = & $worker check
    if ($LASTEXITCODE -ne 0) { throw 'The compiled worker did not start.' }
    $probe = $probe | ConvertFrom-Json
    if ($probe.protocol -ne 1 -or $probe.bits -ne 64 -or $probe.frida -ne '17.26.3' -or -not $probe.frozen) {
        throw 'The compiled worker did not pass its startup check.'
    }
    $licenses = Join-Path $app 'licenses'
    $null = New-Item -ItemType Directory -Path $licenses
    Copy-Item -LiteralPath (Join-Path $buildInfo.base 'LICENSE.txt') -Destination (Join-Path $licenses 'Python.txt')
    Copy-Item -LiteralPath (Join-Path $buildInfo.site 'frida-17.26.3.dist-info\licenses\COPYING') -Destination (Join-Path $licenses 'Frida.txt')
    Copy-Item -LiteralPath (Join-Path $buildInfo.site 'pyinstaller-6.22.3.dist-info\licenses\COPYING.txt') -Destination (Join-Path $licenses 'PyInstaller.txt')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Push-Location $app
    try { & $node $vsce package --no-dependencies --target win32-x64 --allow-missing-repository --out (Join-Path $bundle $vsixName) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed.' }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'install.ps1'), (Join-Path $projectRoot 'README.md') -Destination $bundle
    $pendingZip = Join-Path $stage 'release.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $pendingZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Copy-Item -LiteralPath (Join-Path $bundle $vsixName) -Destination (Join-Path $projectRoot $vsixName) -Force
    $workerOutput = Join-Path $releaseRoot 'bin'
    $null = New-Item -ItemType Directory -Path $workerOutput -Force
    Copy-Item -LiteralPath $worker -Destination (Join-Path $workerOutput 'local-chat-worker.exe') -Force
    Copy-Item -LiteralPath $pendingZip -Destination $zipPath -Force
    $stream = [IO.File]::OpenRead($zipPath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    [IO.File]::WriteAllText(($zipPath + '.sha256'), "$hash  $([IO.Path]::GetFileName($zipPath))`n", [Text.Encoding]::ASCII)
    Write-Host "Release: $zipPath"
    Write-Host "SHA256: $hash"
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedRoot = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedStage) -notmatch '^\.stage-[0-9a-f]{32}$') {
        throw 'Refusing to remove a staging directory outside the release folder.'
    }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
