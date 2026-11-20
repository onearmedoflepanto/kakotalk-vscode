[CmdletBinding()]
param([Parameter(Mandatory)][string] $RoomId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
$clients = @(Get-Process -Name KakaoTalk)
if ($clients.Count -ne 1) { throw 'Expected one KakaoTalk process.' }
$client = $clients[0]
$probe = [LocalChatResearch.ClientMessageProbe]::new($client.Id, $client.Path)
$checks = [Collections.Generic.List[string]]::new()
try {
    $room = @($probe.ReadRoomStates($true) | Where-Object { $_.Id -ceq $RoomId })
    if ($room.Count -ne 1) { throw 'Selected room unavailable.' }
    $title = $room[0].Title
    $first = $probe.FindInputTarget($RoomId, $title)
    if (-not $probe.IsCurrentProcess($client.Id) -or $probe.IsCurrentProcess([Diagnostics.Process]::GetCurrentProcess().Id)) { throw 'Process identity validation failed.' }
    $checks.Add('Current process accepted; another PID rejected')
    for ($i=0; $i -lt 5; $i++) {
        $cached = $probe.FindInputTarget($RoomId, $title)
        if (-not [Object]::ReferenceEquals($first,$cached) -or -not $probe.IsInputTargetCurrent($cached)) { throw 'Valid target was not reused.' }
    }
    if ($probe.InputDiscoveryCount -ne 1 -or $probe.InputCacheHitCount -ne 5) { throw 'Unexpected repeated memory scan.' }
    $checks.Add('Five repeated lookups use one initial scan')
    # Change only the local cache record, never client memory or a window.
    $editor = $first.Editor
    $first.Editor = 0
    if ($probe.IsInputTargetCurrent($first) -or $probe.CheckInputContext($first,'','') -cne 'ROOM_CHANGED') { throw 'Stale editor accepted.' }
    $recovered = $probe.FindInputTarget($RoomId,$title)
    if ($probe.InputDiscoveryCount -ne 2 -or $recovered.Editor -ne $editor -or [Object]::ReferenceEquals($first,$recovered)) { throw 'Stale editor did not trigger discovery.' }
    $checks.Add('Stale cached editor is rejected and rediscovered before input')
    $rejected = $false
    try { $null = $probe.FindInputTarget($RoomId, $title + ' invalid') } catch { $rejected = $true }
    if (-not $rejected) { throw 'Wrong title accepted.' }
    $checks.Add('Mismatched room title rejected')
    $target = $probe.FindInputTarget($RoomId,$title)
    $before = $probe.InputDiscoveryCount
    $probe.ClearInputTargets()
    $target = $probe.FindInputTarget($RoomId,$title)
    if ($probe.InputDiscoveryCount -ne $before + 1) { throw 'Explicit invalidation did not clear the cache.' }
    $checks.Add('Explicit invalidation forces discovery')
    $request = @{ pid=$client.Id; roomId=$RoomId; roomTitle=$title; inputTarget=@{
        dialog=[LocalChatResearch.ClientMessageProbe]::Hex($target.Dialog)
        window=[LocalChatResearch.ClientMessageProbe]::Hex($target.Window)
        editor=[LocalChatResearch.ClientMessageProbe]::Hex($target.Editor)
        processStartFileTime=$probe.ProcessStartFileTime.ToString()
    } }
    $probe.Dispose()
    if ($probe.IsCurrentProcess($client.Id) -or $probe.IsInputTargetCurrent($target)) { throw 'Disposed session accepted.' }
    $checks.Add('Disposed process session rejects cached targets')
    $result = @{ observedAt=[DateTimeOffset]::UtcNow.ToString('o'); checks=@($checks); request=$request; sentMessages=0; inputChanged=$false }
    [IO.File]::WriteAllText((Join-Path $root '.generated/integration/input-cache-validation.json'), ($result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    @{passed=$checks.Count;checks=@($checks);sentMessages=0;inputChanged=$false} | ConvertTo-Json -Depth 4
} finally { $probe.Dispose(); $client.Dispose() }
