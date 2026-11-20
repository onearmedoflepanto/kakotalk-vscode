[CmdletBinding()]
param(
    [int] $TargetProcessId = 0,
    [string] $RoomId,
    [string] $ExpectedPath,
    [string] $OutputName = 'session.json',
    [switch] $ListRooms,
    [switch] $Stdout
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($OutputName -notmatch '^[a-z0-9-]+\.json$') { throw 'Use a simple JSON filename.' }
Add-Type -Path (Join-Path $PSScriptRoot '../ClientMessageProbe.cs')
if ($TargetProcessId -eq 0) {
    $candidates = @(Get-Process -Name KakaoTalk -ErrorAction SilentlyContinue)
    if ($candidates.Count -ne 1) { throw 'Exactly one running KakaoTalk process is required.' }
    $TargetProcessId = $candidates[0].Id
}
$processInfo = Get-Process -Id $TargetProcessId
if (-not $ExpectedPath) { $ExpectedPath = $processInfo.Path }
$probe = [LocalChatResearch.ClientMessageProbe]::new($TargetProcessId, $ExpectedPath)
try {
    if ($ListRooms) {
        @{ pid = $TargetProcessId; rooms = @($probe.DiscoverRooms() | ForEach-Object { @{ id = $_.Id; title = $_.Title } }) } | ConvertTo-Json -Depth 5 -Compress
        return
    }
    $metadata = $probe.PrepareCollector($RoomId)
    $document = [ordered]@{
        schemaVersion = 1
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        pid = $TargetProcessId
        path = $ExpectedPath
        processStartFileTime = $processInfo.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        fileSha256 = $probe.FileSha256
        roomId = $metadata.RoomId
        roomTitle = $metadata.RoomTitle
        roomObject = $metadata.RoomObject
        profiles = @($metadata.Profiles | ForEach-Object { @{ id = $_.Id; address = $_.Address } })
        baselineMessageIds = @($metadata.BaselineMessageIds)
        initialLogs = @($metadata.InitialLogs)
    }
    if ($Stdout) { $document | ConvertTo-Json -Depth 5 -Compress; return }
    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.generated/collector'))
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $destination = Join-Path $root $OutputName
    [IO.File]::WriteAllText($destination, ($document | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{
        ProcessId = $TargetProcessId; RoomId = $metadata.RoomId; RoomTitle = $metadata.RoomTitle
        ProfileCount = $metadata.Profiles.Count; BaselineCount = $metadata.BaselineMessageIds.Count
        ScannedBytes = $metadata.ScannedBytes; ReadFailures = $metadata.ReadFailures; OutputPath = $destination
    } | ConvertTo-Json
} finally { $probe.Dispose() }
