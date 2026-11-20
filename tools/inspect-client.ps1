[CmdletBinding(DefaultParameterSetName = 'Inspect')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Inspect')]
    [ValidateRange(1, 2147483647)]
    [int] $TargetProcessId,
    [Parameter(ParameterSetName = 'Inspect')]
    [string] $ExpectedPath = 'C:\Program Files\KakaoTalk\KakaoTalk.exe',
    [Parameter(ParameterSetName = 'Inspect')]
    [string] $CandidatePattern = 'chat|message|conversation|talklog|logitem|msg',
    [Parameter(ParameterSetName = 'Inspect')]
    [string] $OutputPath,
    [Parameter(ParameterSetName = 'Inspect')]
    [switch] $TraceVTables,
    [Parameter(Mandatory, ParameterSetName = 'SelfTest')]
    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'ClientImageInspector.cs')
if ($SelfTest) {
    $passed = [LocalChatResearch.ClientImageInspector]::SelfTest()
    [pscustomobject]@{ Passed = $passed.Count; Tests = $passed } | ConvertTo-Json -Depth 4
    exit 0
}

$file = Get-Item -LiteralPath $ExpectedPath
$fileHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$result = [LocalChatResearch.ClientImageInspector]::Inspect($TargetProcessId, $file.FullName, $CandidatePattern, $TraceVTables.IsPresent)
$document = [pscustomobject]@{
    SchemaVersion = 1
    ObservedAt = [DateTimeOffset]::Now.ToString('o')
    FileVersion = $file.VersionInfo.FileVersion
    FileSha256 = $fileHash
    Method = 'ReadProcessMemory; main-image MEM_IMAGE pages; readable non-guard regions only'
    Inspection = $result
}
$json = $document | ConvertTo-Json -Depth 12
if ($OutputPath) {
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $evidenceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.generated\research'))
    $destination = [IO.Path]::GetFullPath($OutputPath)
    if (-not $destination.StartsWith($evidenceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'OutputPath must be under this project .generated/research directory.'
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::WriteAllText($destination, $json, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{
    FileVersion = $document.FileVersion
    FileSha256 = $fileHash
    ImageBase = $result.ImageBase
    ImageSize = $result.ImageSize
    ReadableBytes = $result.ReadableBytes
    ReadFailures = $result.ReadFailures
    RttiNameCount = $result.RttiNameCount
    CandidateCount = $result.Candidates.Count
    Candidates = @($result.Candidates | Select-Object -First 80 Name, TypeDescriptorRva, @{Name='LocatorCount';Expression={$_.Locators.Count}})
    OutputPath = $OutputPath
} | ConvertTo-Json -Depth 6
