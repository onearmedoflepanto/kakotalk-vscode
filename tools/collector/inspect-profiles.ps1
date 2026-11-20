[CmdletBinding()]
param([Parameter(Mandatory)][int] $TargetProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../ClientImageInspector.cs')
$inspection = [LocalChatResearch.ClientImageInspector]::Inspect($TargetProcessId, 'C:\Program Files\KakaoTalk\KakaoTalk.exe', '^\.\?AVTalkUser(_Mutable)?@@$', $false)
foreach ($candidate in $inspection.Candidates) {
    foreach ($locator in $candidate.Locators) {
        if ($locator.ObjectOffset -eq 0) {
            [pscustomobject]@{ Name = $candidate.Name; Vtables = @($locator.VTables | ForEach-Object { $_.Rva }) } | ConvertTo-Json
        }
    }
}
