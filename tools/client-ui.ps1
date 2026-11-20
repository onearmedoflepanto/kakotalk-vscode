[CmdletBinding()]
param([switch] $CompileOnly, [switch] $InspectOnly, [int] $ProcessId, [switch] $Worker)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot 'ClientMessageProbe.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'ClientChatWindow.cs')
if ($CompileOnly) { @{ compiled = $true; sentMessages = 0 } | ConvertTo-Json -Compress; return }
if ($InspectOnly) {
    if ($ProcessId -le 0) { throw 'ProcessId is required for inspection.' }
    @{ inputs = @([LocalChatResearch.ClientChatWindow]::InspectInputs($ProcessId)); sentMessages = 0 } | ConvertTo-Json -Depth 4 -Compress
    return
}
$script:inputProbe = $null
function Get-InputProbe([int] $TargetId) {
    if ($script:inputProbe -and -not $script:inputProbe.IsCurrentProcess($TargetId)) {
        $script:inputProbe.Dispose(); $script:inputProbe = $null
    }
    if (-not $script:inputProbe) {
        $processInfo = Get-Process -Id $TargetId
        try { $script:inputProbe = [LocalChatResearch.ClientMessageProbe]::new($TargetId, $processInfo.Path) }
        finally { $processInfo.Dispose() }
    }
    return $script:inputProbe
}
function Invoke-ClientSubmission([string] $Raw, [bool] $Correlated) {
    $request = $null
    try {
        if ($Raw.Length -gt 20000) { throw 'Request too large.' }
        $request = $Raw | ConvertFrom-Json
        if ($Correlated -and ($request.requestId -isnot [string] -or $request.requestId -notmatch '^[1-9][0-9]{0,15}$')) { throw 'Invalid request ID.' }
        if ($request.roomId -notmatch '^[1-9][0-9]{0,19}$' -or $request.pid -le 0) { throw 'Invalid selected room.' }
        if ($null -ne $request.operation -and $request.operation -cne 'prepare') { throw 'Invalid operation.' }
        $probe = Get-InputProbe $request.pid
        $target = $probe.FindInputTarget($request.roomId, $request.roomTitle)
        if ($request.operation -ceq 'prepare') {
            $result = @{ status = 'prepared'; roomId = $request.roomId; inputTarget = @{
                dialog = [LocalChatResearch.ClientMessageProbe]::Hex($target.Dialog)
                window = [LocalChatResearch.ClientMessageProbe]::Hex($target.Window)
                editor = [LocalChatResearch.ClientMessageProbe]::Hex($target.Editor)
                processStartFileTime = $probe.ProcessStartFileTime.ToString()
            } }
        } else {
            $replyId = ''; $replySender = ''
            if ($null -ne $request.replyTo) {
                if ($request.replyTo.id -isnot [string] -or $request.replyTo.id -notmatch '^[1-9][0-9]{0,19}$' -or $request.replyTo.senderId -isnot [string] -or $request.replyTo.senderId -notmatch '^[1-9][0-9]{0,19}$') { throw [LocalChatResearch.ClientSubmitException]::new('REPLY_MISMATCH') }
                if ($request.text.Length -gt 500) { throw [LocalChatResearch.ClientSubmitException]::new('INVALID_TEXT') }
                $replyId = $request.replyTo.id; $replySender = $request.replyTo.senderId
            }
            $checkContext = [Action] {
                $problem = $probe.CheckInputContext($target, $replyId, $replySender)
                if ($problem) { throw [LocalChatResearch.ClientSubmitException]::new($problem) }
            }
            $submitted = [LocalChatResearch.ClientChatWindow]::Submit($request.pid, $request.roomTitle, $request.text, $checkContext, $target.Window, $target.Editor)
            $result = @{ status = 'submitted'; inputCleared = $submitted }
        }
    } catch {
        $cause = $_.Exception.GetBaseException()
        $code = 'CLIENT_ERROR'
        if ($cause -is [LocalChatResearch.ClientSubmitException]) { $code = $cause.Code }
        if ($script:inputProbe -and $code -in @('CLIENT_ERROR','ROOM_CHANGED','WINDOW_UNAVAILABLE','INPUT_UNAVAILABLE')) { $script:inputProbe.ClearInputTargets() }
        $result = @{ status = 'error'; code = $code }
    }
    if ($Correlated) { $result.requestId = [string] $request.requestId }
    return $result
}

try { if ($Worker) {
    [Console]::Out.WriteLine('{"status":"ready","protocolVersion":1}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $result = Invoke-ClientSubmission $line $true
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        $line = $null
    }
} else {
    $result = Invoke-ClientSubmission ([Console]::In.ReadToEnd()) $false
    $result | ConvertTo-Json -Compress
    if ($result.status -notin @('submitted','prepared')) { exit 1 }
} } finally { if ($script:inputProbe) { $script:inputProbe.Dispose(); $script:inputProbe = $null } }
