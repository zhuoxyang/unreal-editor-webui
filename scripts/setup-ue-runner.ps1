param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [ValidatePattern("^\d+\.\d+\.\d+$")]
    [string]$RunnerVersion = "2.336.0",

    [ValidatePattern("^[0-9a-fA-F]{64}$")]
    [string]$RunnerSha256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162",

    [string]$RunnerRoot = "C:\actions-runner-unreal-editor-webui-ue58",

    [string]$RunnerName = "$env:COMPUTERNAME-ue-5.8",

    [string]$UERoot = "C:\Program Files\Epic Games\UE_5.8",

    [string]$Labels = "self-hosted,windows,gui,ue-5.8",

    [switch]$Ephemeral,

    [switch]$InstallService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Ephemeral -and $InstallService) {
    throw "Ephemeral runners must be started interactively; do not combine -Ephemeral with -InstallService."
}

$NormalizedLabels = @($Labels.Split(",") | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
if ($InstallService -and $NormalizedLabels -contains "gui") {
    throw "GUI-labelled runners must run interactively in a logged-in desktop session; do not install them as a Windows service."
}

$RunUAT = Join-Path $UERoot "Engine/Build/BatchFiles/RunUAT.bat"
$EditorCmd = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
$Editor = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor.exe"
$BuildVersionPath = Join-Path $UERoot "Engine/Build/Build.version"
if (-not (Test-Path -LiteralPath $RunUAT -PathType Leaf)) {
    throw "RunUAT not found: $RunUAT"
}
if (-not (Test-Path -LiteralPath $EditorCmd -PathType Leaf)) {
    throw "UnrealEditor-Cmd not found: $EditorCmd"
}
if (-not (Test-Path -LiteralPath $Editor -PathType Leaf)) {
    throw "UnrealEditor not found: $Editor"
}
if (-not (Test-Path -LiteralPath $BuildVersionPath -PathType Leaf)) {
    throw "Unreal Engine Build.version not found: $BuildVersionPath"
}

$EngineLabel = @($NormalizedLabels | Where-Object { $_ -match '^ue-\d+\.\d+$' })
if ($EngineLabel.Count -ne 1) {
    throw "Runner labels must contain exactly one engine label such as ue-5.8."
}
$ExpectedEngineVersion = $EngineLabel[0].Substring(3)
$BuildVersion = Get-Content -LiteralPath $BuildVersionPath -Raw | ConvertFrom-Json
$DetectedEngineVersion = "$($BuildVersion.MajorVersion).$($BuildVersion.MinorVersion)"
if ($DetectedEngineVersion -ne $ExpectedEngineVersion) {
    throw "Runner label $($EngineLabel[0]) does not match the installed engine version $DetectedEngineVersion at $UERoot."
}

if ($ExpectedEngineVersion -eq "5.8") {
    $VSWhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $VSWhere -PathType Leaf)) {
        throw "vswhere.exe is required to validate the UE 5.8 compiler toolchain."
    }

    $VSInstallPath = @(& $VSWhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)[0]
    $VSVersionText = @(& $VSWhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion)[0]
    if ([string]::IsNullOrWhiteSpace($VSInstallPath) -or [string]::IsNullOrWhiteSpace($VSVersionText)) {
        throw "Visual Studio with the Desktop C++ toolchain was not found."
    }

    $VSVersion = [version]$VSVersionText
    if ($VSVersion -lt [version]"17.14") {
        throw "This repository's UE 5.8 runner baseline requires Visual Studio 2022 17.14 or Visual Studio 2026 18.x; detected $VSVersionText."
    }

    $MSVCRoot = Join-Path $VSInstallPath "VC/Tools/MSVC"
    $DetectedToolsets = @(
        Get-ChildItem -LiteralPath $MSVCRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $CompilerPath = Join-Path $_.FullName "bin/Hostx64/x64/cl.exe"
                if (Test-Path -LiteralPath $CompilerPath -PathType Leaf) {
                    $VersionInfo = (Get-Item -LiteralPath $CompilerPath).VersionInfo
                    $CompilerVersion = [version]"$($VersionInfo.ProductMajorPart).$($VersionInfo.ProductMinorPart).$($VersionInfo.ProductBuildPart)"
                    [pscustomobject]@{
                        CompilerVersion = $CompilerVersion
                        FamilyDirectory = $_.Name
                    }
                }
            }
    )
    $CompatibleToolsets = @(
        $DetectedToolsets | Where-Object {
            ($_.CompilerVersion -ge [version]"14.44.35211" -and $_.CompilerVersion -lt [version]"14.45") -or
                ($_.CompilerVersion -ge [version]"14.50.35723" -and $_.CompilerVersion -lt [version]"14.51")
        }
    )
    if ($CompatibleToolsets.Count -eq 0) {
        $DetectedVersions = @($DetectedToolsets | ForEach-Object { "$($_.CompilerVersion) (family $($_.FamilyDirectory))" }) -join ", "
        throw "This repository's UE 5.8 runner baseline requires a non-banned MSVC compiler product version (14.44.35211+ within 14.44, or 14.50.35723+ within 14.50); detected $($DetectedVersions.Trim() -replace '^$', 'none') under $MSVCRoot."
    }
}

$ExpectedUERoot = [System.IO.Path]::GetFullPath("C:\Program Files\Epic Games\UE_$ExpectedEngineVersion").TrimEnd('\')
$ResolvedUERoot = [System.IO.Path]::GetFullPath($UERoot).TrimEnd('\')
if (-not $ResolvedUERoot.Equals($ExpectedUERoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The checked-in UE workflow uses the standard path $ExpectedUERoot. Refusing to register a runner against $ResolvedUERoot because it would accept jobs it cannot execute."
}

New-Item -ItemType Directory -Path $RunnerRoot -Force | Out-Null
$RunnerRootPath = (Resolve-Path -LiteralPath $RunnerRoot).Path

$ArchiveName = "actions-runner-win-x64-$RunnerVersion.zip"
$ArchivePath = Join-Path $RunnerRootPath $ArchiveName
$DownloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$ArchiveName"
$ConfigPath = Join-Path $RunnerRootPath "config.cmd"

$ExistingEntries = @(Get-ChildItem -LiteralPath $RunnerRootPath -Force)
if ($ExistingEntries.Count -gt 0) {
    throw "Runner root must be empty so every executable comes from the archive verified during this setup run: $RunnerRootPath"
}

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath

    $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ExpectedSha256 = $RunnerSha256.ToLowerInvariant()
    if ($ActualSha256 -ne $ExpectedSha256) {
        throw "GitHub Actions runner SHA-256 mismatch. Expected $ExpectedSha256, received $ActualSha256."
    }

    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RunnerRootPath
}
finally {
    if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
        Remove-Item -LiteralPath $ArchivePath -Force
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
