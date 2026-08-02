param(
    [Parameter(Mandatory = $true)]
    [string]$RunUAT,

    [Parameter(Mandatory = $true)]
    [string]$PackageDir,

    [Parameter(Mandatory = $true)]
    [string]$SourceCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-FileSystemEntry {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    try {
        Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop | Out-Null
        return $true
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return $false
    }
}

if ($SourceCommit.Length -ne 40 -or $SourceCommit -notmatch "\A[0-9a-fA-F]{40}\z") {
    throw "SourceCommit must be a full 40-character Git commit SHA."
}
if (-not (Test-Path -LiteralPath $RunUAT -PathType Leaf)) {
    throw "RunUAT path not found: $RunUAT"
}
$PackageFullPath = [System.IO.Path]::GetFullPath($PackageDir)
$PackageParent = [System.IO.Path]::GetDirectoryName($PackageFullPath)
if ([string]::IsNullOrWhiteSpace($PackageParent) -or -not (Test-Path -LiteralPath $PackageParent -PathType Container)) {
    throw "PackageDir parent directory does not exist: $PackageParent"
}
if (Test-FileSystemEntry -LiteralPath $PackageFullPath) {
    throw "PackageDir must not already exist: $PackageFullPath"
}

$RunUATPath = (Resolve-Path -LiteralPath $RunUAT).Path
$StageScript = Join-Path $PSScriptRoot "stage-plugin-from-commit.mjs"
$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("UnrealEditorWebUI-" + [System.Guid]::NewGuid().ToString("N"))
$PluginStage = Join-Path $StagingDir "UnrealEditorWebUI"
$SourceManifest = Join-Path $StagingDir "SourceManifest.json"
$PluginDescriptor = Join-Path $PluginStage "UnrealEditorWebUI.uplugin"
$BuildPackageDir = $null
$PrimaryError = $null
$ExternalExitCode = $null
$CleanupErrors = @()

try {
    New-Item -ItemType Directory -Path $StagingDir | Out-Null

    & node $StageScript $SourceCommit $PluginStage $SourceManifest
    $StageExitCode = $LASTEXITCODE
    if ($StageExitCode -ne 0) {
        $ExternalExitCode = $StageExitCode
        throw "Exact-commit staging failed with exit code $StageExitCode."
    }

    if (-not (Test-Path -LiteralPath $PluginDescriptor -PathType Leaf)) {
        throw "Exact-commit staging did not create the plugin descriptor."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PluginStage "Web/dist/index.html") -PathType Leaf)) {
        throw "Exact-commit frontend build did not create Web/dist/index.html."
    }
    if (-not (Test-Path -LiteralPath $SourceManifest -PathType Leaf)) {
        throw "Exact-commit staging did not create SourceManifest.json."
    }
    if (Test-FileSystemEntry -LiteralPath $PackageFullPath) {
        throw "PackageDir was created while exact-commit staging ran: $PackageFullPath"
    }
    $BuildPackageDir = Join-Path $PackageParent (".unreal-editor-webui-package-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $BuildPackageDir | Out-Null

    & $RunUATPath BuildPlugin `
        "-Plugin=$PluginDescriptor" `
        "-Package=$BuildPackageDir" `
        -Rocket

    $RunUATExitCode = $LASTEXITCODE
    if ($RunUATExitCode -ne 0) {
        $ExternalExitCode = $RunUATExitCode
        throw "RunUAT BuildPlugin failed with exit code $RunUATExitCode."
    }

    $PackagedDescriptor = Join-Path $BuildPackageDir "UnrealEditorWebUI.uplugin"
    $PackagedFrontend = Join-Path $BuildPackageDir "Web/dist/index.html"
    $PackagedLicense = Join-Path $BuildPackageDir "LICENSE"
    if (-not (Test-Path -LiteralPath $PackagedDescriptor -PathType Leaf)) {
        throw "Packaged plugin descriptor missing: $PackagedDescriptor"
    }
    if (-not (Test-Path -LiteralPath $PackagedFrontend -PathType Leaf)) {
        throw "Packaged frontend entry point missing: $PackagedFrontend"
    }
    if (-not (Test-Path -LiteralPath $PackagedLicense -PathType Leaf)) {
        throw "Packaged plugin license missing: $PackagedLicense"
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PackagedLicense).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PluginStage "LICENSE")).Hash) {
        throw "Packaged plugin license does not match the selected commit."
    }

    Copy-Item -LiteralPath $SourceManifest -Destination (Join-Path $BuildPackageDir "SourceManifest.json")
    if (Test-FileSystemEntry -LiteralPath $PackageFullPath) {
        throw "PackageDir was created before exact package publication: $PackageFullPath"
    }
    [System.IO.Directory]::Move($BuildPackageDir, $PackageFullPath)
    $BuildPackageDir = $null
}
catch {
    $PrimaryError = $_
}
finally {
    try {
        if ($null -ne $BuildPackageDir -and (Test-FileSystemEntry -LiteralPath $BuildPackageDir)) {
            Remove-Item -LiteralPath $BuildPackageDir -Recurse -Force -ErrorAction Stop
        }
    }
    catch {
        $CleanupErrors += $_
    }
    try {
        if (Test-FileSystemEntry -LiteralPath $StagingDir) {
            Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction Stop
        }
    }
    catch {
        $CleanupErrors += $_
    }
}

if ($null -ne $PrimaryError) {
    Write-Error -ErrorRecord $PrimaryError -ErrorAction Continue
}
foreach ($CleanupError in $CleanupErrors) {
    Write-Error -Message ("Packaging cleanup failed: " + $CleanupError.Exception.Message) -ErrorAction Continue
}
if ($null -ne $ExternalExitCode) {
    exit $ExternalExitCode
}
if ($null -ne $PrimaryError -or $CleanupErrors.Count -gt 0) {
    exit 1
}
