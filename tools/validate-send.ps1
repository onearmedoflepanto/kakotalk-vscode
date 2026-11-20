[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $ProcessId,
    [Parameter(Mandatory)][string] $RoomTitle,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+\.json$')][string] $OutputName,
    [switch] $MinimizeBeforeSend,
    [switch] $SubmitOnce
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $SubmitOnce) { throw 'Explicit SubmitOnce is required after authorizing the target and test text.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $root ('.generated/integration/' + $OutputName)
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ClientChatWindow.cs')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChatValidationWindow {
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    public static void Minimize(string handle) {
        ShowWindowAsync(new IntPtr(Convert.ToInt64(handle, 16)), 6);
    }
}
'@
# Fixed, non-private test text approved for a user's own chat; never take a message from a file.
$testText = 'Local Chat ' + (-join ([char[]] @(0xC804, 0xC1A1, 0x20, 0xD14C, 0xC2A4, 0xD2B8)))
$targetProcess = Get-Process -Id $ProcessId
$probe = [LocalChatResearch.ClientMessageProbe]::new($ProcessId, $targetProcess.Path)
$evidence = [ordered]@{ observedAt = [DateTimeOffset]::UtcNow.ToString('o'); pid = $ProcessId; roomTitle = $RoomTitle; sendRequested = $false; directServerCalls = $false }
function InputState {
    $items = @([LocalChatResearch.ClientChatWindow]::InspectInputs($ProcessId) | Where-Object { $_.WindowTitle -ceq $RoomTitle })
    if ($items.Count -ne 1) { throw 'The authorized chat window is not unique or not open.' }
    return $items[0]
}
function Snapshot($metadata) {
    $roomAddress = [Convert]::ToUInt64($metadata.RoomObject.Substring(2), 16)
    if ($probe.TypeName($roomAddress) -ne '.?AVTalkChatRoom@@') { return $null }
    $pointerBytes = $probe.Read($roomAddress + 0xe8, 8)
    if (-not $pointerBytes) { return $null }
    $cached = [BitConverter]::ToUInt64($pointerBytes, 0) + 0x20
    $header = $probe.Read($cached, 0x40)
    if (-not $header -or [BitConverter]::ToUInt64($header, 8).ToString() -ne $metadata.RoomId -or [BitConverter]::ToUInt32($header, 0x10) -ne 1) { return $null }
    $body = $probe.ReadString([BitConverter]::ToUInt64($header, 0x30), $false)
    if (-not $body -or -not $body.Stable) { return $null }
    $again = $probe.Read($cached, 0x40)
    if (-not $again -or [Convert]::ToBase64String($header) -cne [Convert]::ToBase64String($again)) { return $null }
    return [ordered]@{ id = [BitConverter]::ToUInt64($header, 0).ToString(); roomId = $metadata.RoomId;
        senderId = [BitConverter]::ToUInt64($header, 0x18).ToString(); bodySha256 = $body.Sha256; matchesExpectedText = $body.Text -ceq $testText }
}
function SaveEvidence { [IO.File]::WriteAllText($output, ($evidence | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false)) }
try {
    $rooms = @($probe.DiscoverRooms() | Where-Object { $_.Title -ceq $RoomTitle })
    if ($rooms.Count -ne 1) { throw 'The authorized room title is ambiguous or missing.' }
    $metadata = $probe.PrepareCollector($rooms[0].Id)
    $evidence.roomId = $metadata.RoomId
    $evidence.beforeMessage = Snapshot $metadata
    $evidence.beforeInput = InputState
    if (-not $evidence.beforeInput.EmptyDraft) { throw 'An existing draft is present. Nothing was sent.' }
    # Reserve an immutable attempt identity before any UI changes. A rerun cannot submit twice.
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
    $reservation = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $reservation.Dispose()
    if ($MinimizeBeforeSend) {
        [ChatValidationWindow]::Minimize($evidence.beforeInput.WindowHandle)
        Start-Sleep -Milliseconds 300
    }
    $evidence.preSubmitInput = InputState
    if ($MinimizeBeforeSend -and -not $evidence.preSubmitInput.Minimized) { throw 'Minimization was not confirmed. Nothing was sent.' }
    if (-not $evidence.preSubmitInput.EmptyDraft) { throw 'A draft appeared. Nothing was sent.' }
    $evidence.sendRequested = $true
    SaveEvidence
    try { $evidence.submitReturned = [LocalChatResearch.ClientChatWindow]::Submit($ProcessId, $RoomTitle, $testText) }
    catch { $evidence.submitError = $_.Exception.GetBaseException().Message }
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $evidence.afterMessage = Snapshot $metadata
        if ($evidence.afterMessage -and $evidence.afterMessage.matchesExpectedText -and $metadata.BaselineMessageIds -notcontains $evidence.afterMessage.id) { break }
        Start-Sleep -Milliseconds 300
    }
    $evidence.afterInput = InputState
    $evidence.newMessageObserved = $evidence.afterMessage -and $evidence.afterMessage.matchesExpectedText -and $metadata.BaselineMessageIds -notcontains $evidence.afterMessage.id
    $evidence.minimizedPreserved = $evidence.preSubmitInput.Minimized -and $evidence.afterInput.Minimized
    $evidence.foregroundUnchanged = $evidence.preSubmitInput.ForegroundHandle -ceq $evidence.afterInput.ForegroundHandle
    $evidence.passed = $evidence.submitReturned -eq $true -and $evidence.newMessageObserved -and $evidence.afterInput.EmptyDraft -and (-not $MinimizeBeforeSend -or $evidence.minimizedPreserved)
    SaveEvidence
    $evidence | ConvertTo-Json -Depth 8
    if (-not $evidence.passed) { exit 2 }
} finally { $probe.Dispose() }
