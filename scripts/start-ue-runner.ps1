param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ue54", "ue55", "ue58")]
    [string]$Variant,

    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "rez")]
    [string]$Wave
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SessionProbe = Join-Path $PSScriptRoot "test-interactive-runner-session.ps1"
$SessionResultText = @(& $SessionProbe)
if ($SessionResultText.Count -ne 1) {
    throw "Interactive standard-user session validation failed."
}
$SessionResult = $SessionResultText[0] | ConvertFrom-Json
if ($SessionResult.schemaVersion -ne 1 -or
    $SessionResult.standardUser -ne $true -or
    $SessionResult.inputDesktop -ne $true) {
    throw "Interactive standard-user session validation returned an invalid result."
}

$ControlledRoot = Join-Path $env:LOCALAPPDATA "UnrealEditorWebUI"
$RunnerBase = Join-Path $ControlledRoot "actions-runners"
foreach ($ControlledDirectory in @($env:LOCALAPPDATA, $ControlledRoot, $RunnerBase)) {
    if (-not (Test-Path -LiteralPath $ControlledDirectory -PathType Container)) {
        throw "A dedicated profile runner ancestor is missing."
    }
    $ControlledItem = Get-Item -LiteralPath $ControlledDirectory -Force
    if (($ControlledItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runner profile ancestors must be real non-reparse directories."
    }
}
$RunnerRoot = Join-Path $RunnerBase "$Wave-$Variant"
$RunnerRootPath = (Resolve-Path -LiteralPath $RunnerRoot).Path
$RunnerRootItem = Get-Item -LiteralPath $RunnerRootPath -Force
$ExpectedBasePath = [System.IO.Path]::GetFullPath($RunnerBase).TrimEnd('\') + '\'
if (-not ($RunnerRootPath + '\').StartsWith($ExpectedBasePath, [System.StringComparison]::OrdinalIgnoreCase) -or
    ($RunnerRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The configured runner escaped the dedicated profile runner root."
}

$RunScript = Join-Path $RunnerRootPath "run.cmd"
$RunnerMetadata = Join-Path $RunnerRootPath ".runner"
$BootstrapEvidence = Join-Path $RunnerRootPath "UEWebUIRunnerBootstrap.json"
$RunnerListener = Join-Path $RunnerRootPath "bin/Runner.Listener.exe"
$NodeExecutable = Join-Path $RunnerRootPath "node-v24.18.1-win-x64/node.exe"
if (-not (Test-Path -LiteralPath $RunScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $RunnerMetadata -PathType Leaf) -or
    -not (Test-Path -LiteralPath $BootstrapEvidence -PathType Leaf) -or
    -not (Test-Path -LiteralPath $RunnerListener -PathType Leaf) -or
    -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw "The requested ephemeral runner is not configured."
}
$Bootstrap = Get-Content -LiteralPath $BootstrapEvidence -Raw | ConvertFrom-Json
if ($Bootstrap.schemaVersion -ne 2 -or
    [string]$Bootstrap.variant -cne $Variant -or
    [string]$Bootstrap.wave -cne $Wave -or
    [string]$Bootstrap.state -cne "configured" -or
    $Bootstrap.ephemeral -ne $true -or
    $Bootstrap.noDefaultLabels -ne $true -or
    [string]$Bootstrap.runnerVersion -cne "2.337.0" -or
    [string]$Bootstrap.runnerArchiveSha256 -cne "sha256:1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc" -or
    [string]$Bootstrap.nodeVersion -cne "24.18.1" -or
    [string]$Bootstrap.nodeArchiveSha256 -cne "sha256:ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765") {
    throw "The requested ephemeral runner bootstrap identity is invalid."
}
$RunnerVersionOutput = @(& $RunnerListener --version)
if ($LASTEXITCODE -ne 0 -or
    $RunnerVersionOutput.Count -ne 1 -or
    $RunnerVersionOutput[0] -cne "2.337.0") {
    throw "The requested runner listener version is invalid."
}
$NodeVersionOutput = @(& $NodeExecutable --version)
if ($LASTEXITCODE -ne 0 -or
    $NodeVersionOutput.Count -ne 1 -or
    $NodeVersionOutput[0] -cne "v24.18.1") {
    throw "The requested runner bootstrap Node.js version is invalid."
}

Write-Output "Starting one verified ephemeral GUI listener for $Wave/$Variant."
Push-Location $RunnerRootPath
try {
    & $RunScript
    $RunnerExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($RunnerExitCode -ne 0) {
    throw "The ephemeral runner listener failed with exit code $RunnerExitCode."
}
