[CmdletBinding()]
param([Parameter(Mandatory=$true)][string] $RoomId, [switch] $Scroll, [switch] $Minimize)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ClientHistoryWindow.cs')
$processes = @(Get-Process -Name KakaoTalk -ErrorAction Stop)
if ($processes.Count -ne 1) { throw 'Expected one KakaoTalk process.' }
$processInfo = $processes[0]
$probe = [LocalChatResearch.ClientMessageProbe]::new($processInfo.Id, $processInfo.Path)
try {
    $rooms = @($probe.DiscoverRooms() | Where-Object { $_.Id -eq $RoomId })
    foreach ($room in $rooms) {
        try {
            $target = $probe.FindInputTarget($room.Id, $room.Title)
            if ($Scroll) {
                $metadata = $probe.PrepareCollector($RoomId, [UInt64]::MaxValue.ToString())
                $beforeCount = $metadata.HistoryCandidateCount
                $beforeOldest = $metadata.OldestHistoryId
                $beforeUi = @($metadata.BaselineMessageIds)
                $foreground = [LocalChatResearch.ClientHistoryWindow]::Foreground()
                if ($Minimize) {
                    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HistoryWindowValidation { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command); }'
                    [HistoryWindowValidation]::ShowWindowAsync([IntPtr]::new([long]$target.Window),7) | Out-Null
                    Start-Sleep -Milliseconds 150
                }
                $wasMinimized = [LocalChatResearch.ClientHistoryWindow]::Minimized($target.Window)
                for ($step = 0; $step -lt 3; $step++) {
                    if (-not $probe.IsInputTargetCurrent($target)) { throw 'Client window changed.' }
                    [LocalChatResearch.ClientHistoryWindow]::ScrollOlder($processInfo.Id, $target.Window)
                    Start-Sleep -Milliseconds 250
                }
                $metadata = $probe.PrepareCollector($RoomId, [UInt64]::MaxValue.ToString())
                @{ roomId=$RoomId; beforeCount=$beforeCount; afterCount=$metadata.HistoryCandidateCount; beforeOldest=$beforeOldest; afterOldest=$metadata.OldestHistoryId;
                    newScreenMessageCount=@($metadata.BaselineMessageIds | Where-Object { $beforeUi -notcontains $_ }).Count;
                    olderLoaded=($beforeOldest -and $metadata.OldestHistoryId -and [UInt64]::Parse($metadata.OldestHistoryId) -lt [UInt64]::Parse($beforeOldest));
                    minimizedBefore=$wasMinimized; minimizedAfter=[LocalChatResearch.ClientHistoryWindow]::Minimized($target.Window);
                    foregroundUnchanged=($foreground -eq [LocalChatResearch.ClientHistoryWindow]::Foreground()); sentMessages=0 } | ConvertTo-Json -Compress
                continue
            }
            @{ roomId = $room.Id; title = $room.Title; pid = $processInfo.Id; controls = @([LocalChatResearch.ClientHistoryWindow]::Inspect($target.Window)) } | ConvertTo-Json -Depth 5 -Compress
        } catch { @{roomId=$room.Id; error=$_.Exception.Message} | ConvertTo-Json -Compress }
    }
} finally { $probe.Dispose() }
