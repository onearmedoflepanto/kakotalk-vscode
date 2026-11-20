[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $TargetProcessId,
    [Parameter(Mandatory)][string] $RoomTitle,
    [ValidatePattern('^[a-z0-9-]+\.json$')][string] $OutputName = 'snapshot.json',
    [string] $RttiPath = '.generated/research/client-rtti-20261116.json'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rtti = Get-Content -LiteralPath (Join-Path $root $RttiPath) -Raw -Encoding UTF8 | ConvertFrom-Json
$processInfo = Get-Process -Id $TargetProcessId
$probe = [LocalChatResearch.ClientMessageProbe]::new($TargetProcessId, $processInfo.Path)
function Address([string] $value) { [Convert]::ToUInt64(($value -replace '^0x', ''), 16) }
function Hex([uint64] $value) { [LocalChatResearch.ClientMessageProbe]::Hex($value) }
function U64([uint64] $at) {
    $bytes = $probe.Read($at, 8)
    if ($null -eq $bytes) { return [uint64]0 }
    [BitConverter]::ToUInt64($bytes, 0)
}
function U32([uint64] $at) {
    $bytes = $probe.Read($at, 4)
    if ($null -eq $bytes) { throw 'Unreadable field.' }
    [BitConverter]::ToUInt32($bytes, 0)
}
function Read-Fields([uint64] $at, [int] $length) {
    try { @($probe.Fields($at, $length)) } catch { @() }
}
function Read-Strings([uint64] $at, [int] $length) {
    $seen = @{}
    for ($offset = 0; $offset -lt $length; $offset += 8) {
        foreach ($wide in @($false, $true)) {
            $value = $probe.ReadString((U64 ($at + $offset)), $wide)
            if ($null -eq $value -or -not $value.Stable -or $value.Text -match '[\x00-\x08\x0b\x0c\x0e-\x1f]') { continue }
            $key = $value.Sha256 + ':' + $value.Encoding
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [pscustomobject]@{ offset = Hex $offset; encoding = $value.Encoding; text = $value.Text; sha256 = $value.Sha256 }
        }
    }
}
function Read-StdStrings([uint64] $at, [int] $length) {
    for ($offset = 0; $offset + 32 -le $length; $offset += 8) {
        foreach ($wide in @($false, $true)) {
            $value = $probe.ReadStdString(($at + $offset), $wide)
            if ($value -and $value.Stable -and $value.Text -notmatch '[\x00-\x08\x0b\x0c\x0e-\x1f]') {
                [pscustomobject]@{ offset = Hex $offset; encoding = $value.Encoding; text = $value.Text; sha256 = $value.Sha256 }
            }
        }
    }
}
function Read-VariantCandidate([uint64] $at, [int] $depth) {
    if ($depth -gt 10 -or $script:entryBudget-- -le 0) { throw 'Attachment traversal limit reached.' }
    $tag = U32 $at
    $data = U64 ($at + 8)
    $textPointer = U64 ($at + 16)
    $decoded = $null
    if ($tag -eq 1) {
        $textValue = $probe.ReadString($textPointer, $false)
        if ($textValue -and $textValue.Stable) { $decoded = $textValue.Text }
    } elseif ($tag -eq 3) { $decoded = $data.ToString() }
    elseif ($tag -eq 4) { $decoded = @(Read-MapCandidate $data ($depth + 1)) }
    elseif ($tag -eq 5) {
        $begin = U64 $data; $end = U64 ($data + 8); $capacity = U64 ($data + 16)
        if ($end -lt $begin -or $capacity -lt $end -or ($end - $begin) % 24 -ne 0 -or ($end - $begin) / 24 -gt 128) { throw 'Invalid attachment array boundary.' }
        $decoded = @(for ($element = $begin; $element -lt $end; $element += 24) { Read-VariantCandidate $element ($depth + 1) })
        if ((U64 $data) -ne $begin -or (U64 ($data + 8)) -ne $end -or (U64 ($data + 16)) -ne $capacity) { throw 'Attachment array changed while reading.' }
    } elseif ($tag -eq 8 -and $data -le 1) { $decoded = [bool]$data }
    if ((U32 $at) -ne $tag -or (U64 ($at + 8)) -ne $data -or (U64 ($at + 16)) -ne $textPointer) { throw 'Attachment changed while reading.' }
    [pscustomobject]@{ tag = $tag; raw = Hex $data; value = $decoded }
}
function Read-MapCandidate([uint64] $at, [int] $depth = 0) {
    if ($depth -gt 10) { throw 'Attachment nesting limit reached.' }
    $head = U64 ($at + 0x10)
    $count = U64 ($at + 0x18)
    if ($count -lt 1 -or $count -gt 128 -or $head -lt 0x10000) { return }
    $stack = [Collections.Generic.Stack[uint64]]::new()
    $stack.Push((U64 ($head + 8)))
    $seen = @{}
    while ($stack.Count -gt 0 -and $seen.Count -lt $count) {
        $node = $stack.Pop()
        if ($node -eq $head -or $node -lt 0x10000 -or $seen.ContainsKey($node)) { continue }
        $seen[$node] = $true
        $key = $probe.ReadString((U64 ($node + 0x20)), $false)
        if (-not $key -or -not $key.Stable -or $key.Text.Length -gt 100) { return }
        $value = U64 ($node + 0x28)
        $innerKey = $probe.ReadString((U64 $value), $false)
        if (-not $innerKey -or -not $innerKey.Stable -or $innerKey.Text -cne $key.Text) { throw 'Attachment key mismatch.' }
        $variant = Read-VariantCandidate ($value + 8) $depth
        [pscustomobject]@{ key = $key.Text; tag = $variant.tag; pointer = Hex $value; raw = $variant.raw; value = $variant.value }
        $stack.Push((U64 $node)); $stack.Push((U64 ($node + 0x10)))
    }
    if ($seen.Count -ne $count -or (U64 ($at + 0x10)) -ne $head -or (U64 ($at + 0x18)) -ne $count) { throw 'Attachment map changed while reading.' }
}
try {
    if ($rtti.FileSha256 -ne $probe.FileSha256) { throw 'RTTI build mismatch.' }
    $tables = [Collections.Generic.List[uint64]]::new()
    $names = [Collections.Generic.List[string]]::new()
    $selectedClasses = '^\.\?AV(ChatLogContent_[A-Za-z]+|TalkChatRoom|TalkChatRoomInfo(?:_Mutable)?|TalkChatRoomManager|ChatListItemDataHeader|ChatThreadModel|ChatThreadListModel|ChatThreadListItemViewModel|AttentionChatThreadListItemViewModel)@@$'
    foreach ($candidate in $rtti.Inspection.Candidates) {
        if ($candidate.Name -notmatch $selectedClasses) { continue }
        foreach ($locator in $candidate.Locators) {
            if ($locator.ObjectOffset -ne 0) { continue }
            foreach ($table in $locator.VTables) { $tables.Add((Address $table.Rva)); $names.Add($candidate.Name) }
        }
    }
    $search = $probe.FindObjects($tables.ToArray(), $names.ToArray())
    if ($search.ScanLimitReached -or $search.ObjectLimitReached) { throw 'Object scan incomplete.' }
    $rooms = @()
    foreach ($item in $search.Objects) {
        if ($item.Class -ne '.?AVTalkChatRoom@@') { continue }
        $at = Address $item.Address
        $info = U64 ($at + 0x188)
        if ($probe.TypeName($at) -ne $item.Class -or $probe.TypeName($info) -ne '.?AVTalkChatRoomInfo_Mutable@@') { continue }
        $title = $probe.ReadString((U64 ($info + 0x40)), $true)
        $id = U64 ($info + 0x18)
        if (-not $title -or -not $title.Stable -or $id -eq 0 -or $title.Text.Length -gt 256) { continue }
        $db = U64 ($at + 0xe8)
        $log = $db + 0x20
        $logMatches = (U64 ($log + 8)) -eq $id
        $roomRecord = [pscustomobject]@{
            id = $id.ToString(); title = $title.Text; address = $item.Address; infoAddress = Hex $info
            cachedId = $(if ($logMatches) { (U64 $log).ToString() } else { $null })
            infoFields = @(Read-Fields $info 0x118)
            roomFields = @(Read-Fields $at 0x200)
            cachedFields = $(if ($title.Text -ceq $RoomTitle -and $logMatches) { @(Read-Fields $log 0x100) } else { @() })
            cachedStrings = $(if ($title.Text -ceq $RoomTitle -and $logMatches) { @(Read-Strings $log 0x100) } else { @() })
            cachedStdStrings = $(if ($title.Text -ceq $RoomTitle -and $logMatches) { @(Read-StdStrings $log 0x100) } else { @() })
        }
        if ((U64 ($at + 0x188)) -ne $info -or (U64 ($info + 0x18)) -ne $id) { throw 'Room identity changed while reading.' }
        $rooms += $roomRecord
    }
    $selectedIds = @($rooms | Where-Object { $_.title -ceq $RoomTitle } | Select-Object -ExpandProperty id -Unique)
    if ($selectedIds.Count -ne 1) { throw 'Expected exactly one matching room ID in memory.' }
    $selectedId = $selectedIds[0]
    $messages = @()
    $script:entryBudget = 4096
    foreach ($item in $search.Objects) {
        if ($item.Class -notmatch '^\.\?AVChatLogContent_') { continue }
        $at = Address $item.Address
        if ((U64 ($at + 0x60)).ToString() -ne $selectedId -or $probe.TypeName($at) -ne $item.Class) { continue }
        $id = U64 ($at + 0x68)
        if ($id -eq 0) { continue }
        if ($messages.Count -ge 100) { throw 'Selected room message limit reached.' }
        $attachmentTag = U32 ($at + 0xf8)
        $attachmentPointer = U64 ($at + 0x100)
        $messages += [pscustomobject]@{
            id = $id.ToString(); roomId = $selectedId; address = $item.Address; class = $item.Class
            fields = @(Read-Fields $at 0x300); strings = @(Read-Strings $at 0x300)
            stdStrings = @(Read-StdStrings $at 0x300)
            mapCandidate = @($(if ($attachmentTag -eq 4) { Read-MapCandidate $attachmentPointer }))
        }
        if ((U64 ($at + 0x60)).ToString() -ne $selectedId -or (U64 ($at + 0x68)) -ne $id -or
            $probe.TypeName($at) -ne $item.Class -or (U32 ($at + 0xf8)) -ne $attachmentTag -or
            (U64 ($at + 0x100)) -ne $attachmentPointer) { throw 'Message identity changed while reading.' }
    }
    $models = @($search.Objects | Where-Object { $_.Class -eq '.?AVTalkChatRoomManager@@' -or $_.Class -eq '.?AVChatListItemDataHeader@@' } | Select-Object -First 32 | ForEach-Object {
        [pscustomobject]@{ address = $_.Address; class = $_.Class; fields = @(Read-Fields (Address $_.Address) 0x200) }
    })
    $document = [ordered]@{
        schemaVersion = 1; observedAt = [DateTimeOffset]::UtcNow.ToString('o'); pid = $TargetProcessId
        fileSha256 = $probe.FileSha256; imageBase = Hex $probe.ImageBase
        method = 'ReadProcessMemory only; no client invocation, input, network calls or hooks.'
        roomTitle = $RoomTitle; roomId = $selectedId; scannedBytes = $search.ScannedBytes
        scanLimitReached = $search.ScanLimitReached; objectLimitReached = $search.ObjectLimitReached
        classes = @($search.Objects | Group-Object Class | ForEach-Object { @{ name = $_.Name; count = $_.Count } })
        rooms = $rooms; messages = $messages; models = $models
        limitation = 'Raw offsets are candidates, not validated field semantics. UI subclasses may have different layouts. Strings are read only from the selected room.'
    }
    $directory = Join-Path $root '.generated/research/capabilities'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $destination = Join-Path $directory $OutputName
    [IO.File]::WriteAllText($destination, ($document | ConvertTo-Json -Depth 32 -Compress), [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{
        outputPath = $destination; roomId = $selectedId; roomCount = $rooms.Count; messageCount = $messages.Count
        classes = $document.classes
        messages = @($messages | ForEach-Object { @{ id = $_.id; class = $_.class; mapKeys = @($_.mapCandidate | ForEach-Object { $_.key }) } })
    } | ConvertTo-Json -Depth 8
} finally { $probe.Dispose() }
