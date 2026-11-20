$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../tools/ClientChatWindow.cs')
$hint = -join ([char[]] @(0xBA54, 0xC2DC, 0xC9C0, 0x20, 0xC785, 0xB825))
$replyHint = (-join ([char[]] @(0xB2F5, 0xC7A5, 0x20))) + $hint
$commentHint = (-join ([char[]] @(0xB313, 0xAE00, 0x20))) + $hint
$cases = @(
    @{ name = 'Empty control'; text = ''; undo = $false; empty = $true },
    @{ name = 'Observed empty-client hint'; text = $hint; undo = $false; empty = $true },
    @{ name = 'User-typed hint-shaped draft'; text = $hint; undo = $true; empty = $false },
    @{ name = 'Existing draft without undo history'; text = 'draft'; undo = $false; empty = $false },
    @{ name = 'Whitespace draft'; text = " `r`n"; undo = $false; empty = $false },
    @{ name = 'Hint with trailing newline'; text = $hint + "`r`n"; undo = $false; empty = $false },
    @{ name = 'Empty reply hint'; text = $replyHint; undo = $false; empty = $true },
    @{ name = 'User-typed reply hint'; text = $replyHint; undo = $true; empty = $false },
    @{ name = 'Observed empty comment hint'; text = $commentHint; undo = $false; empty = $true },
    @{ name = 'User-typed comment hint'; text = $commentHint; undo = $true; empty = $false },
    @{ name = 'Comment hint with trailing newline'; text = $commentHint + "`r`n"; undo = $false; empty = $false }
)
foreach ($case in $cases) {
    if ([LocalChatResearch.ClientChatWindow]::IsEmptyDraft($case.text, $case.undo) -ne $case.empty) { throw $case.name }
}
foreach ($inputHint in @($hint, $replyHint, $commentHint)) {
    if (-not [LocalChatResearch.ClientChatWindow]::IsSubmissionCleared('body', $inputHint, $false)) { throw 'Returned hint was not recognized.' }
    if ([LocalChatResearch.ClientChatWindow]::IsSubmissionCleared($inputHint, $inputHint, $false)) { throw 'Identical text falsely confirmed submission.' }
}
if ([LocalChatResearch.ClientChatWindow]::IsSubmissionCleared('body', 'body', $false)) { throw 'Retained draft falsely confirmed submission.' }
try { throw [LocalChatResearch.ClientSubmitException]::new('DRAFT_EXISTS') }
catch { if ($_.Exception.GetBaseException().Code -ne 'DRAFT_EXISTS') { throw 'Structured error lost its code.' } }
try { [LocalChatResearch.ClientChatWindow]::Submit(0, '', '') | Out-Null; throw 'Invalid text was accepted.' }
catch { if ($_.Exception.GetBaseException().Code -ne 'INVALID_TEXT') { throw 'Invocation wrapper lost its native error code.' } }
@{ passed = $cases.Count + 9; nativeUiCalls = 0; sentMessages = 0 } | ConvertTo-Json -Compress
