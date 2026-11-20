[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ClientHistoryWindow.cs')
$probe = $null
$session = ''
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        if ($line.Length -gt 4096) { throw 'Room command exceeds limit.' }
        $request = $line | ConvertFrom-Json
        if ($request.command -notin @('snapshot', 'image-preview', 'history') -or $request.id -notmatch '^\d{1,20}$') { throw 'Invalid room command.' }
        try {
            $candidates = @(Get-Process -Name KakaoTalk -ErrorAction SilentlyContinue)
            if ($candidates.Count -ne 1) { throw '실행 중인 PC카톡을 찾을 수 없습니다.' }
            $processInfo = $candidates[0]
            $identity = $processInfo.Id.ToString() + ':' + $processInfo.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
            if ($identity -ne $session) {
                if ($probe) { $probe.Dispose(); $probe = $null }
                $probe = [LocalChatResearch.ClientMessageProbe]::new($processInfo.Id, $processInfo.Path)
                $session = $identity
            }
            if ($request.command -eq 'history') {
                if ($request.pid -ne $processInfo.Id -or $request.session -cne $identity) { throw 'Client session changed.' }
                foreach ($value in @($request.roomId, $request.before)) {
                    if ($value -isnot [string] -or $value -notmatch '^[1-9][0-9]{0,19}$') { throw 'Invalid history identity.' }
                }
                if ($request.scroll -isnot [bool]) { throw 'Invalid history operation.' }
                $target = $probe.FindInputTarget($request.roomId, $request.roomTitle)
                if (-not $probe.IsInputTargetCurrent($target)) { throw 'History window changed.' }
                if ($request.scroll) {
                    [LocalChatResearch.ClientHistoryWindow]::ScrollOlder($processInfo.Id, $target.Window)
                    Start-Sleep -Milliseconds 180
                }
                $metadata = $probe.PrepareCollector($request.roomId, $request.before)
                if (-not $probe.IsCurrentProcess($processInfo.Id) -or -not $probe.IsInputTargetCurrent($target)) { throw 'History window changed.' }
                @{ id = $request.id; result = @{ pid = $processInfo.Id; session = $identity; roomId = $metadata.RoomId; before = $request.before;
                    profiles = @($metadata.Profiles | ForEach-Object { @{ id = $_.Id; address = $_.Address } });
                    initialLogs = @($metadata.InitialLogs); scrolled = $request.scroll } } | ConvertTo-Json -Depth 5 -Compress
                continue
            }
            if ($request.command -eq 'image-preview') {
                if ($request.pid -ne $processInfo.Id -or $request.session -cne $identity) { throw 'Client session changed.' }
                foreach ($value in @($request.roomId, $request.messageId, $request.senderId)) {
                    if ($value -isnot [string] -or $value -notmatch '^[1-9][0-9]{0,19}$') { throw 'Invalid image identity.' }
                }
                $image = $probe.ReadImagePreview($request.roomId, $request.messageId, $request.senderId)
                @{ id = $request.id; result = @{ mime = $image.Mime; data = $image.Data } } | ConvertTo-Json -Compress
                continue
            }
            $rooms = @($probe.ReadRoomStates([bool]$request.refresh) | ForEach-Object {
                @{ id = $_.Id; title = $_.Title; unreadCount = $_.UnreadCount; lastMessageId = $_.LastMessageId; lastMessageAt = $_.LastMessageAt; lastSenderId = $_.LastSenderId }
            })
            @{ id = $request.id; result = @{ pid = $processInfo.Id; session = $session; rooms = $rooms; selfId = $probe.ReadSelfId() } } | ConvertTo-Json -Depth 5 -Compress
        } catch {
            if ($probe) { $probe.Dispose(); $probe = $null }; $session = ''
            @{ id = $request.id; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
    }
} finally { if ($probe) { $probe.Dispose() } }
