$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../tools/ClientChatWindow.cs'), (Join-Path $PSScriptRoot 'client-window.test.cs'))
$passed = [ChatWindowFixture]::Validate()
$samples = [ChatWindowFixture]::MeasureSubmissions()
$json = @{ passed = $passed; target = 'isolated native RichEdit fixtures'; kakaoMessagesSent = 0; nativeSubmissionMs = @($samples) } | ConvertTo-Json -Compress
$output = Join-Path $PSScriptRoot '../.generated/integration/send-latency-native.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
[IO.File]::WriteAllText($output, $json, [Text.UTF8Encoding]::new($false))
$json
