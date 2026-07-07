param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$RunnerRoot = "C:\actions-runner-unreal-editor-webui",

    [string]$RunnerName = "$env:COMPUTERNAME-ue-5.5",

    [string]$UERoot = "C:\Program Files\Epic Games\UE_5.5",

    [string]$Labels = "self-hosted,windows,ue-5.5",

    [switch]$InstallService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RunUAT = Join-Path $UERoot "Engine/Build/BatchFiles/RunUAT.bat"
$EditorCmd = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
if (-not (Test-Path -LiteralPath $RunUAT -PathType Leaf)) {
    throw "RunUAT not found: $RunUAT"
}
if (-not (Test-Path -LiteralPath $EditorCmd -PathType Leaf)) {
    throw "UnrealEditor-Cmd not found: $EditorCmd"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required on the runner PATH."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required on the runner PATH."
}

New-Item -ItemType Directory -Path $RunnerRoot -Force | Out-Null
$RunnerRootPath = (Resolve-Path -LiteralPath $RunnerRoot).Path

$LatestRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/actions/runner/releases/latest"
$Asset = $LatestRelease.assets |
    Where-Object { $_.name -like "actions-runner-win-x64-*.zip" } |
    Select-Object -First 1

if ($null -eq $Asset) {
    throw "Could not find a Windows x64 GitHub Actions runner asset in the latest release."
}

$ArchivePath = Join-Path $RunnerRootPath $Asset.name
if (-not (Test-Path -LiteralPath (Join-Path $RunnerRootPath "config.cmd") -PathType Leaf)) {
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $ArchivePath
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RunnerRootPath -Force
    Remove-Item -LiteralPath $ArchivePath -Force
}

Push-Location $RunnerRootPath
try {
    & .\config.cmd `
        --url $RepoUrl `
        --token $Token `
        --name $RunnerName `
        --labels $Labels `
        --work "_work" `
        --unattended `
        --replace

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

Write-Output "Configured runner '$RunnerName' at $RunnerRootPath with labels: $Labels"
