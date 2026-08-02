param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [ValidatePattern("^\d+\.\d+\.\d+$")]
    [string]$RunnerVersion = "2.336.0",

    [ValidatePattern("^[0-9a-fA-F]{64}$")]
    [string]$RunnerSha256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162",

    [string]$RunnerRoot = "C:\actions-runner-unreal-editor-webui",

    [string]$RunnerName = "$env:COMPUTERNAME-ue-5.5",

    [string]$UERoot = "C:\Program Files\Epic Games\UE_5.5",

    [string]$Labels = "self-hosted,windows,ue-5.5",

    [switch]$Ephemeral,

    [switch]$InstallService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Ephemeral -and $InstallService) {
    throw "Ephemeral runners must be started interactively; do not combine -Ephemeral with -InstallService."
}

$RunUAT = Join-Path $UERoot "Engine/Build/BatchFiles/RunUAT.bat"
$EditorCmd = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
if (-not (Test-Path -LiteralPath $RunUAT -PathType Leaf)) {
    throw "RunUAT not found: $RunUAT"
}
if (-not (Test-Path -LiteralPath $EditorCmd -PathType Leaf)) {
    throw "UnrealEditor-Cmd not found: $EditorCmd"
}
New-Item -ItemType Directory -Path $RunnerRoot -Force | Out-Null
$RunnerRootPath = (Resolve-Path -LiteralPath $RunnerRoot).Path

$ArchiveName = "actions-runner-win-x64-$RunnerVersion.zip"
$ArchivePath = Join-Path $RunnerRootPath $ArchiveName
$DownloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$ArchiveName"
$ConfigPath = Join-Path $RunnerRootPath "config.cmd"

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    $ExistingEntries = @(Get-ChildItem -LiteralPath $RunnerRootPath -Force)
    if ($ExistingEntries.Count -gt 0) {
        throw "Runner root is not empty and does not contain config.cmd. Refusing to overlay a verified runner archive onto unknown files: $RunnerRootPath"
    }

    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath

        $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $ExpectedSha256 = $RunnerSha256.ToLowerInvariant()
        if ($ActualSha256 -ne $ExpectedSha256) {
            throw "GitHub Actions runner SHA-256 mismatch. Expected $ExpectedSha256, received $ActualSha256."
        }

        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RunnerRootPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
            Remove-Item -LiteralPath $ArchivePath -Force
        }
    }
}

$RunnerListener = Join-Path $RunnerRootPath "bin/Runner.Listener.exe"
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $RunnerListener -PathType Leaf)) {
    throw "The verified GitHub Actions runner archive did not contain the expected executables."
}

$VersionOutput = & $RunnerListener --version
$VersionExitCode = $LASTEXITCODE
if ($VersionExitCode -ne 0) {
    throw "Could not read the installed GitHub Actions runner version (exit code $VersionExitCode)."
}

$InstalledVersionMatch = [regex]::Match(($VersionOutput -join "`n"), "\d+\.\d+\.\d+")
if (-not $InstalledVersionMatch.Success -or $InstalledVersionMatch.Value -ne $RunnerVersion) {
    $DetectedVersion = if ($InstalledVersionMatch.Success) { $InstalledVersionMatch.Value } else { "unknown" }
    throw "Runner root contains version $DetectedVersion, but this setup requires $RunnerVersion. Use a clean runner root or perform a reviewed upgrade."
}

Push-Location $RunnerRootPath
try {
    $ConfigArguments = @(
        "--url", $RepoUrl,
        "--token", $Token,
        "--name", $RunnerName,
        "--labels", $Labels,
        "--work", "_work",
        "--unattended",
        "--replace"
    )
    if ($Ephemeral) {
        $ConfigArguments += "--ephemeral"
    }

    & .\config.cmd @ConfigArguments

    if ($LASTEXITCODE -ne 0) {
        throw "GitHub runner config failed with exit code $LASTEXITCODE"
    }

    if ($InstallService) {
        & .\svc.cmd install
        if ($LASTEXITCODE -ne 0) {
            throw "Runner service install failed with exit code $LASTEXITCODE"
        }

        & .\svc.cmd start
        if ($LASTEXITCODE -ne 0) {
            throw "Runner service start failed with exit code $LASTEXITCODE"
        }
    }
}
finally {
    Pop-Location
}

Write-Output "Configured verified GitHub Actions runner v$RunnerVersion '$RunnerName' at $RunnerRootPath with labels: $Labels"
