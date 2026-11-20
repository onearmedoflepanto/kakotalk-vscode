[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $TargetProcessId,
    [ValidateSet('Validate', 'Find', 'References', 'Object', 'String', 'StdString', 'Code', 'ObjectStrings')][string] $Mode = 'Validate',
    [string] $ExpectedPath = 'C:\Program Files\KakaoTalk\KakaoTalk.exe',
    [string] $Needle,
    [string] $ExpectedSender,
    [string] $ExpectedRoom,
    [string[]] $Addresses,
    [int] $Length = 256,
    [switch] $Wide,
    [string] $OutputName
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$probe = [LocalChatResearch.ClientMessageProbe]::new($TargetProcessId, $ExpectedPath)
try {
    $values = @($Addresses | Where-Object { $_ } | ForEach-Object { $_ -split ',' } | ForEach-Object { [Convert]::ToUInt64(($_ -replace '^0x', ''), 16) })
    if ($Mode -eq 'Find') {
            $rtti = Get-Content -LiteralPath (Join-Path $projectRoot '.generated/research/client-rtti-20261116.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($rtti.FileSha256 -ne [LocalChatResearch.ClientMessageProbe]::ExpectedHash) { throw 'RTTI evidence is for another build.' }
            $tables = @(); $names = @()
            foreach ($candidate in $rtti.Inspection.Candidates) {
                if ($candidate.Name -notmatch '^\.\?AV(ChatLogContent_|TalkChatRoom@@|TalkChatRoomInfo)') { continue }
                foreach ($locator in $candidate.Locators) {
                    if ($locator.ObjectOffset -ne 0) { continue }
                    foreach ($table in $locator.VTables) {
                        $tables += [Convert]::ToUInt64($table.Rva.Substring(2), 16)
                        $names += $candidate.Name
                    }
                }
            }
    }
    switch ($Mode) {
        Validate { $result = $probe.Validate($Needle, $ExpectedSender, $ExpectedRoom) }
        Find {
            $result = $probe.Find($Needle, [uint64[]]$tables, [string[]]$names)
            $matchedUi = @()
            foreach ($candidate in $result.Objects) {
                if ($candidate.Class -notmatch 'ChatLogContent_') { continue }
                $objectAddress = [Convert]::ToUInt64($candidate.Address.Substring(2), 16)
                $pointerBytes = $probe.Read($objectAddress + 0xe8, 8)
                if (-not $pointerBytes) { continue }
                $body = $probe.ReadString([BitConverter]::ToUInt64($pointerBytes, 0), $true)
                if ($body -and $body.Stable -and $body.Text.Contains($Needle)) {
                    $matchedUi += [pscustomobject]@{
                        Address = $candidate.Address
                        Class = $candidate.Class
                        BodyPointer = $body.Pointer
                        BodyLength = $body.Length
                        BodySha256 = $body.Sha256
                        BodyEqualsNeedle = $body.Text -ceq $Needle
                        Fields = $probe.Fields($objectAddress, 288)
                    }
                }
            }
            $result | Add-Member -NotePropertyName MatchedUiObjects -NotePropertyValue $matchedUi
        }
        References { $result = $probe.References([uint64[]]$values) }
        Object { $result = @($values | ForEach-Object { [pscustomobject]@{ Address = [LocalChatResearch.ClientMessageProbe]::Hex($_); Fields = $probe.Fields($_, $Length) } }) }
        String { $result = @($values | ForEach-Object { $probe.ReadString($_, $Wide.IsPresent) } | Where-Object { $_ -and (-not $Needle -or $_.Text.Contains($Needle)) }) }
        StdString { $result = @($values | ForEach-Object { $probe.ReadStdString($_, $Wide.IsPresent) } | Where-Object { $_ -and (-not $Needle -or $_.Text.Contains($Needle)) }) }
        ObjectStrings {
            if (-not $Needle) { throw 'ObjectStrings requires the selected sender or room name.' }
            $result = @()
            foreach ($address in $values) {
                foreach ($field in $probe.Fields($address, $Length)) {
                    foreach ($isWide in @($false, $true)) {
                        $stringValue = $probe.ReadString([uint64]$field.Unsigned, $isWide)
                        if ($stringValue -and $stringValue.Stable -and $stringValue.Text.Contains($Needle)) {
                            $result += [pscustomobject]@{ Object = [LocalChatResearch.ClientMessageProbe]::Hex($address); Offset = $field.Offset; String = $stringValue }
                        }
                    }
                }
            }
        }
        Code {
            if ($values.Count -ne 1) { throw 'Code requires one module-relative address.' }
            $result = [pscustomobject]@{ Rva = $Addresses[0]; Hex = [BitConverter]::ToString($probe.Code([uint32]$values[0], $Length)).Replace('-', '') }
        }
    }
    $document = [pscustomobject]@{
        ObservedAt = [DateTimeOffset]::Now.ToString('o')
        ProcessId = $TargetProcessId
        Mode = $Mode
        FileSha256 = [LocalChatResearch.ClientMessageProbe]::ExpectedHash
        ImageBase = [LocalChatResearch.ClientMessageProbe]::Hex($probe.ImageBase)
        ScannedBytes = $probe.ScannedBytes
        ReadFailures = $probe.ReadFailures
        ScanLimitReached = $probe.ScanLimitReached
        Result = $result
    }
    $json = $document | ConvertTo-Json -Depth 10
    if ($OutputName) {
        if ($OutputName -notmatch '^[a-z0-9-]+\.json$' -or $Mode -in @('String', 'StdString', 'ObjectStrings')) { throw 'Use a simple evidence filename; string contents are not saved.' }
        $directory = Join-Path $projectRoot '.generated/research/message-validation'
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        [IO.File]::WriteAllText((Join-Path $directory $OutputName), $json, [Text.UTF8Encoding]::new($false))
    }
    if ($Mode -eq 'Find' -and $OutputName) {
        [pscustomobject]@{
            ScannedBytes = $probe.ScannedBytes
            ReadFailures = $probe.ReadFailures
            ScanLimitReached = $probe.ScanLimitReached
            TextLimitReached = $result.TextLimitReached
            ObjectLimitReached = $result.ObjectLimitReached
            Text = $result.Text
            ObjectCounts = @($result.Objects | Group-Object Class | Select-Object Name, Count)
            MatchedUiObjects = $result.MatchedUiObjects
            OutputName = $OutputName
        } | ConvertTo-Json -Depth 10
    } elseif ($Mode -eq 'Object') {
        foreach ($item in $result) {
            "Object: $($item.Address) $($item.Class)"
            $item.Fields | Format-Table Offset, Hex, Unsigned, PointeeType -AutoSize | Out-String -Width 240
        }
    } else { $json }
    if ($Mode -eq 'Validate' -and $result.Status -ne 'matched') { exit 2 }
} finally { $probe.Dispose() }
