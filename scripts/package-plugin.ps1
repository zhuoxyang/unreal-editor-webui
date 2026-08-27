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

function Get-ExistingVolumeIdentity {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if ($null -eq (Get-Command Get-Volume -ErrorAction SilentlyContinue)) {
        return $null
    }

    try {
        $Volumes = @(Get-Volume -FilePath $LiteralPath -ErrorAction Stop)
        if ($Volumes.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$Volumes[0].UniqueId)) {
            return $null
        }
        return [string]$Volumes[0].UniqueId
    }
    catch {
        return $null
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $Stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "")
        }
        finally {
            $Hasher.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
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

$SystemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not (Test-Path -LiteralPath $SystemTempRoot -PathType Container)) {
    throw "System temporary directory does not exist: $SystemTempRoot"
}

# UnrealBuildTool still rejects action paths longer than 260 characters even on
# long-path-enabled Windows hosts. Keep BuildPlugin's private output under the
# much shorter system temp directory only when Windows reports that it is on
# the package volume. Volume identities handle junctions and mount points that
# a drive-letter comparison cannot distinguish. A same-volume Directory.Move
# preserves fail-if-present atomic publication.
$PackageVolume = Get-ExistingVolumeIdentity -LiteralPath $PackageParent
$TempVolume = Get-ExistingVolumeIdentity -LiteralPath $SystemTempRoot
$UseSystemTempBuildRoot = $false
$BuildRoot = $PackageParent
if (
    $null -ne $PackageVolume -and
    $null -ne $TempVolume -and
    [string]::Equals($PackageVolume, $TempVolume, [System.StringComparison]::OrdinalIgnoreCase)
) {
    $BuildRoot = $SystemTempRoot
    $UseSystemTempBuildRoot = $true
}

$RunUATPath = (Resolve-Path -LiteralPath $RunUAT).Path
$EngineDirectory = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $RunUATPath))
$EngineBuildVersionPath = Join-Path $EngineDirectory "Build/Build.version"
$HoudiniDescriptorPath = Join-Path $EngineDirectory "Plugins/Runtime/HoudiniEngine/HoudiniEngine.uplugin"
$ExpectedHoudiniDescriptorSha256 = "44E6A8335FE84D80FADDC5D11D3BA3107C4DABBD044763BA42913E478AB7B1C4"
$HoudiniDescriptorSha256Before = $null
$RunUATCompatibilityArguments = @()
if (Test-Path -LiteralPath $HoudiniDescriptorPath -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $EngineBuildVersionPath -PathType Leaf)) {
        throw "The engine Build.version required by the closed Houdini compatibility profile is missing."
    }
    $EngineBuildVersion = Get-Content -LiteralPath $EngineBuildVersionPath -Raw | ConvertFrom-Json
    if ([int]$EngineBuildVersion.MajorVersion -eq 5 -and [int]$EngineBuildVersion.MinorVersion -eq 4) {
        $ExpectedUE54Identity = [ordered]@{
            MajorVersion = 5
            MinorVersion = 4
            PatchVersion = 4
            Changelist = 35576357
            CompatibleChangelist = 33043543
            BranchName = "++UE5+Release-5.4"
            IsLicenseeVersion = 0
            IsPromotedBuild = 1
        }
        foreach ($Field in $ExpectedUE54Identity.Keys) {
            if ($EngineBuildVersion.$Field -cne $ExpectedUE54Identity[$Field]) {
                throw "The installed UE 5.4 build is outside the closed Houdini compatibility profile."
            }
        }
        $HoudiniDescriptorSha256Before = Get-Sha256Hex -LiteralPath $HoudiniDescriptorPath
        if ($HoudiniDescriptorSha256Before -cne $ExpectedHoudiniDescriptorSha256) {
            throw "The installed UE 5.4 Houdini descriptor is outside the closed compatibility profile."
        }

        # This is intentionally one fixed UAT architecture argument. Do not expose
        # arbitrary BuildPlugin arguments or edit/disable the installed engine plugin.
        $RunUATCompatibilityArguments += "-Architecture_Win64=x64 -DisablePlugin=HoudiniEngine"
        Write-Output "Applying the closed read-only UE 5.4 BuildPlugin compatibility profile."
    }
}
$StageScript = Join-Path $PSScriptRoot "stage-plugin-from-commit.mjs"
$StagingDir = Join-Path $SystemTempRoot ("uews-" + [System.Guid]::NewGuid().ToString("N"))
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
    $BuildPackageDir = Join-Path $BuildRoot ("uewp-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $BuildPackageDir | Out-Null

    $RunUATArguments = @(
        "BuildPlugin",
        "-Plugin=$PluginDescriptor",
        "-Package=$BuildPackageDir",
        "-Rocket"
    )
    $RunUATArguments += $RunUATCompatibilityArguments
    & $RunUATPath @RunUATArguments

    $RunUATExitCode = $LASTEXITCODE
    if ($null -ne $HoudiniDescriptorSha256Before) {
        if (-not (Test-Path -LiteralPath $HoudiniDescriptorPath -PathType Leaf) -or
            (Get-Sha256Hex -LiteralPath $HoudiniDescriptorPath) -cne $HoudiniDescriptorSha256Before) {
            $ExternalExitCode = 1
            throw "RunUAT changed the protected UE 5.4 Houdini descriptor."
        }
    }
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
    if ((Get-Sha256Hex -LiteralPath $PackagedLicense) -ne (Get-Sha256Hex -LiteralPath (Join-Path $PluginStage "LICENSE"))) {
        throw "Packaged plugin license does not match the selected commit."
    }

    Copy-Item -LiteralPath $SourceManifest -Destination (Join-Path $BuildPackageDir "SourceManifest.json")
    if (Test-FileSystemEntry -LiteralPath $PackageFullPath) {
        throw "PackageDir was created before exact package publication: $PackageFullPath"
    }
    if ($UseSystemTempBuildRoot) {
        $CurrentBuildVolume = Get-ExistingVolumeIdentity -LiteralPath $BuildPackageDir
        $CurrentPackageVolume = Get-ExistingVolumeIdentity -LiteralPath $PackageParent
        if (
            $null -eq $CurrentBuildVolume -or
            $null -eq $CurrentPackageVolume -or
            -not [string]::Equals($CurrentBuildVolume, $CurrentPackageVolume, [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            throw "Private BuildPlugin output is no longer on the final package volume."
        }
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
