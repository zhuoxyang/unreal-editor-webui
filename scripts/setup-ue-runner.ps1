param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")]
    [string]$RepoUrl,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [Parameter(Mandatory = $true)]
    [ValidateSet("ue54", "ue55", "ue58")]
    [string]$Variant,

    [ValidatePattern("^\d+\.\d+\.\d+$")]
    [string]$RunnerVersion = "2.336.0",

    [ValidatePattern("^[0-9a-fA-F]{64}$")]
    [string]$RunnerSha256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162",

    [switch]$Ephemeral
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $NodeCommand) {
    throw "Node.js is required to decode the checked-in UE release variant registry."
}
$NodeVersionValidator = Join-Path $PSScriptRoot "validate-node-version.mjs"
if (-not (Test-Path -LiteralPath $NodeVersionValidator -PathType Leaf)) {
    throw "Node.js version validator not found."
}
& $NodeCommand.Source $NodeVersionValidator
if ($LASTEXITCODE -ne 0) {
    throw "The runner setup requires a repository-supported Node.js version."
}
$VariantRegistryScript = Join-Path $PSScriptRoot "ue-release-variants.mjs"
if (-not (Test-Path -LiteralPath $VariantRegistryScript -PathType Leaf)) {
    throw "UE release variant registry script not found."
}
$MatrixText = @(& $NodeCommand.Source $VariantRegistryScript workflow-matrix)
if ($LASTEXITCODE -ne 0 -or $MatrixText.Count -ne 1) {
    throw "Could not decode the checked-in UE release variant registry."
}
$Matrix = $MatrixText[0] | ConvertFrom-Json
$VariantEntries = @($Matrix.include | Where-Object { $_.variant_id -ceq $Variant })
if ($VariantEntries.Count -ne 1 -or @($Matrix.include).Count -ne 3) {
    throw "The checked-in registry does not contain the closed three-variant set."
}
$VariantEntry = $VariantEntries[0]

$RunnerRoot = "C:\actions-runner-unreal-editor-webui-$Variant"
$RunnerName = "unreal-editor-webui-$Variant"
$UERoot = [string]$VariantEntry.ue_root
$Labels = "self-hosted,windows,gui,$($VariantEntry.runner_label)"

$GitCacheToolsValidator = Join-Path $PSScriptRoot "validate-git-cache-tools.ps1"
if (-not (Test-Path -LiteralPath $GitCacheToolsValidator -PathType Leaf)) {
    throw "Git cache tool validator not found."
}
$GitUsrBinOutput = @(& $GitCacheToolsValidator)
if ($GitUsrBinOutput.Count -ne 1) {
    throw "Git cache tool validation did not return exactly one tools directory."
}

$RunUAT = Join-Path $UERoot "Engine/Build/BatchFiles/RunUAT.bat"
$EditorCmd = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
$Editor = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor.exe"
$BuildVersionPath = Join-Path $UERoot "Engine/Build/Build.version"
$EditorVersionPath = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor.version"
$EditorModulesPath = Join-Path $UERoot "Engine/Binaries/Win64/UnrealEditor.modules"
$EmbeddedPythonPath = Join-Path $UERoot "Engine/Binaries/ThirdParty/Python3/Win64/python.exe"
$CefRoot = Join-Path $UERoot "Engine/Binaries/ThirdParty/CEF3/Win64"
foreach ($RequiredFile in @(
    $RunUAT,
    $EditorCmd,
    $Editor,
    $BuildVersionPath,
    $EditorVersionPath,
    $EditorModulesPath,
    $EmbeddedPythonPath
)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "A required UE runner file is missing."
    }
}

$BuildVersion = Get-Content -LiteralPath $BuildVersionPath -Raw | ConvertFrom-Json
$EditorVersion = Get-Content -LiteralPath $EditorVersionPath -Raw | ConvertFrom-Json
$EditorModules = Get-Content -LiteralPath $EditorModulesPath -Raw | ConvertFrom-Json
$ExpectedMajor, $ExpectedMinor = @(
    ([string]$VariantEntry.ue_version).Split('.') | ForEach-Object { [int]$_ }
)
$ExpectedIdentity = @{
    MajorVersion = $ExpectedMajor
    MinorVersion = $ExpectedMinor
    PatchVersion = [int]$VariantEntry.patch_version
    Changelist = [int]$VariantEntry.changelist
    CompatibleChangelist = [int]$VariantEntry.compatible_changelist
    BranchName = [string]$VariantEntry.branch_name
    IsLicenseeVersion = 0
    IsPromotedBuild = 1
}
foreach ($Identity in @($BuildVersion, $EditorVersion)) {
    foreach ($Field in $ExpectedIdentity.Keys) {
        if ($Identity.$Field -cne $ExpectedIdentity[$Field]) {
            throw "$Variant engine identity is not the checked-in exact build."
        }
    }
}
if ([string]$EditorVersion.BuildId -cne [string]$VariantEntry.build_id -or
    [string]$EditorModules.BuildId -cne [string]$VariantEntry.build_id) {
    throw "$Variant Unreal Editor BuildId does not match the checked-in exact build."
}

$DetectedPythonVersion = (Get-Item -LiteralPath $EmbeddedPythonPath).VersionInfo.ProductVersion
if ($DetectedPythonVersion -cne [string]$VariantEntry.python_version) {
    throw "$Variant embedded Python version does not match the checked-in runtime."
}
$CefDlls = @(Get-ChildItem -LiteralPath $CefRoot -Filter libcef.dll -File -Recurse)
if ($CefDlls.Count -ne 1 -or
    $CefDlls[0].VersionInfo.ProductVersion -cne [string]$VariantEntry.cef_product_version) {
    throw "$Variant CEF runtime does not match the checked-in runtime."
}

$VSWhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VSWhere -PathType Leaf)) {
    throw "vswhere.exe is required to validate the exact compiler toolchain."
}
$VSInstallPaths = @(
    & $VSWhere -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
)
$ExpectedToolchainFamily = [string]$VariantEntry.toolchain_family_version
$ExpectedCompilerProduct = [string]$VariantEntry.compiler_product_version
$MatchingCompilers = @()
foreach ($VSInstallPath in $VSInstallPaths) {
    $CompilerPath = Join-Path $VSInstallPath "VC/Tools/MSVC/$ExpectedToolchainFamily/bin/Hostx64/x64/cl.exe"
    if (Test-Path -LiteralPath $CompilerPath -PathType Leaf) {
        $VersionInfo = (Get-Item -LiteralPath $CompilerPath).VersionInfo
        $NormalizedProductVersion = "$($VersionInfo.ProductMajorPart).$($VersionInfo.ProductMinorPart).$($VersionInfo.ProductBuildPart)"
        if ($NormalizedProductVersion -ceq $ExpectedCompilerProduct) {
            $MatchingCompilers += $CompilerPath
        }
    }
}
if ($MatchingCompilers.Count -ne 1) {
    throw "$Variant requires exactly one installed MSVC $ExpectedToolchainFamily / $ExpectedCompilerProduct compiler."
}
$ExpectedSdkVersion = [string]$VariantEntry.windows_sdk_version
$ResourceCompiler = "C:\Program Files (x86)\Windows Kits\10\bin\$ExpectedSdkVersion\x64\rc.exe"
if (-not (Test-Path -LiteralPath $ResourceCompiler -PathType Leaf)) {
    throw "$Variant requires Windows SDK $ExpectedSdkVersion x64 tools."
}

if ([string]$VariantEntry.ue_version -ne "5.8") {
    $DocumentsPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    $UserPythonStartupScript = Join-Path $DocumentsPath "UnrealEngine/Python/init_unreal.py"
    if (Test-Path -LiteralPath $UserPythonStartupScript) {
        throw "$Variant requires a clean Windows profile without a user-global Unreal init_unreal.py."
    }
}

$RunnerSessionId = (Get-Process -Id $PID).SessionId
if ($RunnerSessionId -eq 0) {
    throw "GUI runners must be configured from an interactive Windows desktop session."
}
$SessionExplorer = @(
    Get-Process -Name explorer -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq $RunnerSessionId }
)
if ($SessionExplorer.Count -eq 0) {
    throw "No interactive Windows desktop exists in the current session."
}

if (Test-Path -LiteralPath $RunnerRoot) {
    throw "Runner root must not already exist: $RunnerRoot"
}
New-Item -ItemType Directory -Path $RunnerRoot | Out-Null
$RunnerRootPath = (Resolve-Path -LiteralPath $RunnerRoot).Path
$ArchiveName = "actions-runner-win-x64-$RunnerVersion.zip"
$ArchivePath = Join-Path $RunnerRootPath $ArchiveName
$DownloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$ArchiveName"

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath
    $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -cne $RunnerSha256.ToLowerInvariant()) {
        throw "GitHub Actions runner SHA-256 mismatch."
    }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RunnerRootPath
}
finally {
    if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }
}

$ConfigPath = Join-Path $RunnerRootPath "config.cmd"
$RunnerListener = Join-Path $RunnerRootPath "bin/Runner.Listener.exe"
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $RunnerListener -PathType Leaf)) {
    throw "The verified runner archive did not contain the expected executables."
}
$VersionOutput = & $RunnerListener --version
$VersionExitCode = $LASTEXITCODE
$InstalledVersionMatch = [regex]::Match(($VersionOutput -join "`n"), "(?<!\d)\d+\.\d+\.\d+(?!\d)")
if ($VersionExitCode -ne 0 -or
    -not $InstalledVersionMatch.Success -or
    $InstalledVersionMatch.Value -cne $RunnerVersion) {
    throw "The installed runner version does not match the verified archive version."
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
        "--disableupdate"
    )
    if ($Ephemeral) {
        $ConfigArguments += "--ephemeral"
    }
    & .\config.cmd @ConfigArguments
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub runner configuration failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Write-Output "Configured verified $Variant GUI runner v$RunnerVersion with labels: $Labels. Start run.cmd interactively from this logged-in desktop session."
