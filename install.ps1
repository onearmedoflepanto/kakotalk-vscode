#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$VsixPath,
    [string]$CodePath,
    [string]$ExtensionsDir,
    [string]$UserDataDir,
    [switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ArchiveManifest([string]$Path) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $archive.GetEntry('extension/package.json')
        if ($null -eq $entry) { throw 'The VSIX has no extension manifest.' }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        if ($manifest.publisher -ne 'local-workspace' -or $manifest.name -ne 'kakao-local-chat') {
            throw 'The VSIX is not a Local Chat package.'
        }
        $null = [version]$manifest.version
        foreach ($name in @('extension/bin/local-chat-worker.exe', 'extension/src/extension.cjs',
            'extension/src/runtime.cjs', 'extension/licenses/Python.txt', 'extension/licenses/Frida.txt')) {
            $item = $archive.GetEntry($name)
            if ($null -eq $item -or $item.Length -eq 0) { throw "The VSIX is incomplete: $name" }
        }
        $metadata = $archive.GetEntry('extension.vsixmanifest')
        if ($null -eq $metadata) { throw 'The VSIX platform manifest is missing.' }
        $reader = [IO.StreamReader]::new($metadata.Open())
        try { [xml]$xml = $reader.ReadToEnd() }
        finally { $reader.Dispose() }
        if ($xml.PackageManifest.Metadata.Identity.TargetPlatform -ne 'win32-x64') {
            throw 'A win32-x64 VSIX is required.'
        }
        return $manifest
    } finally { $archive.Dispose() }
}

function Resolve-Code([string]$Requested) {
    $candidates = @()
    if ($Requested) { $candidates = @($Requested) }
    else {
        if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe' }
        if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe' }
        $command = Get-Command code.cmd -CommandType Application -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $executable = (Resolve-Path -LiteralPath $candidate).ProviderPath
        if ([IO.Path]::GetFileName($executable) -ieq 'code.cmd') {
            $executable = Join-Path (Split-Path (Split-Path $executable -Parent) -Parent) 'Code.exe'
        }
        $codeRoot = Split-Path $executable -Parent
        $cli = Join-Path $codeRoot 'resources\app\out\cli.js'
        $launcher = Join-Path $codeRoot 'bin\code.cmd'
        if (Test-Path -LiteralPath $launcher -PathType Leaf) {
            $launcherText = [IO.File]::ReadAllText($launcher)
            if ($launcherText -match '"%~dp0\.\.\\(?<relative>(?:[0-9a-f]{10,40}\\)?resources\\app\\out\\cli\.js)"') {
                $cli = Join-Path $codeRoot $Matches.relative
            }
        }
        if ([IO.Path]::GetFileName($executable) -ieq 'Code.exe' -and
            (Test-Path -LiteralPath $executable -PathType Leaf) -and
            (Test-Path -LiteralPath $cli -PathType Leaf)) { return @($executable, $cli) }
    }
    throw 'VS Code was not found. Install VS Code x64 or use -CodePath with the path to Code.exe.'
}

function Invoke-Code([string[]]$CliArgs) {
    $info = [Diagnostics.ProcessStartInfo]::new($script:codeFiles[0])
    $arguments = @($script:codeFiles[1]) + $CliArgs
    $info.Arguments = ($arguments | ForEach-Object {
        '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    $info.EnvironmentVariables.Remove('VSCODE_DEV')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) { $process.Kill(); $process.WaitForExit(); throw 'VS Code command timed out.' }
        $output = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "VS Code command failed (exit $($process.ExitCode)): $errorText" }
        return @($output -split '\r?\n' | Where-Object { $_.Length -gt 0 })
    } finally { $process.Dispose() }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:OS -ne 'Windows_NT' -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'Local Chat requires Windows x64.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not $VsixPath) {
        $packages = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'kakao-local-chat-*-win32-x64.vsix' -File |
            Where-Object { $_.Name -match '^kakao-local-chat-\d+\.\d+\.\d+-win32-x64\.vsix$' } |
            Sort-Object { [version]($_.Name -replace '^kakao-local-chat-|-win32-x64\.vsix$', '') } -Descending)
        if ($packages.Count -eq 0) { throw 'No Local Chat VSIX was found next to install.ps1. Extract the complete release ZIP first.' }
        $VsixPath = $packages[0].FullName
    }
    if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) { throw 'The VSIX file does not exist.' }
    $VsixPath = (Resolve-Path -LiteralPath $VsixPath).ProviderPath
    $manifest = Get-ArchiveManifest $VsixPath
    $script:codeFiles = Resolve-Code $CodePath
    $versionLines = @(Invoke-Code @('--version'))
    $versions = @($versionLines | Where-Object { $_ -match '^\d+\.\d+\.\d+$' })
    if ($versions.Count -eq 0 -or [version]$versions[0] -lt [version]'1.85.0' -or
        [version]$versions[0] -ge [version]'2.0.0' -or $versionLines -notcontains 'x64') {
        throw 'VS Code 1.85 or later (1.x, x64) is required.'
    }
    $cliOptions = @()
    if ($ExtensionsDir) { $cliOptions += @('--extensions-dir', [IO.Path]::GetFullPath($ExtensionsDir)) }
    if ($UserDataDir) { $cliOptions += @('--user-data-dir', [IO.Path]::GetFullPath($UserDataDir)) }
    if ($CheckOnly) {
        Write-Host "Ready to install Local Chat $($manifest.version). Worker is included."
        exit 0
    }
    Invoke-Code ($cliOptions + @('--install-extension', $VsixPath, '--force')) | ForEach-Object { Write-Host $_ }
    $installed = @(Invoke-Code ($cliOptions + @('--list-extensions', '--show-versions')))
    if ($installed -notcontains "local-workspace.kakao-local-chat@$($manifest.version)") {
        throw 'The expected extension version was not found after installation.'
    }
    Write-Host "Local Chat $($manifest.version) installed. Restart VS Code to use it."
} catch {
    [Console]::Error.WriteLine("Local Chat installation failed: $($_.Exception.Message)")
    exit 1
}
