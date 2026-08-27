param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")]
    [string]$RepoUrl,

    [Parameter(Mandatory = $true)]
    [ValidateSet("ue54", "ue55", "ue58")]
    [string]$Variant,

    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "rez")]
    [string]$Wave,

    [System.Security.SecureString]$RegistrationToken,

    [Parameter(Mandatory = $true)]
    [switch]$DedicatedRunnerAccount
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RunnerVersion = "2.337.0"
$RunnerSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"
$NodeVersion = "24.18.1"
$NodeSha256 = "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765"

if (-not $DedicatedRunnerAccount.IsPresent) {
    throw "Runner setup requires an explicit dedicated-standard-account acknowledgement."
}

$SessionProbe = Join-Path $PSScriptRoot "test-interactive-runner-session.ps1"
if (-not (Test-Path -LiteralPath $SessionProbe -PathType Leaf)) {
    throw "Interactive runner session validator not found."
}
$SessionResultText = @(& $SessionProbe)
if ($SessionResultText.Count -ne 1) {
    throw "Interactive standard-user session validation did not return one result."
}
$SessionResult = $SessionResultText[0] | ConvertFrom-Json
if ($SessionResult.schemaVersion -ne 1 -or
    $SessionResult.standardUser -ne $true -or
    $SessionResult.activeConsole -ne $true -or
    $SessionResult.inputDesktop -ne $true -or
    $SessionResult.profileLoaded -ne $true) {
    throw "Interactive standard-user session validation returned an invalid result."
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
    -not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container)) {
    throw "The dedicated runner profile has no LocalAppData directory."
}
$LocalAppDataPath = (Resolve-Path -LiteralPath $env:LOCALAPPDATA).Path
$ControlledRoot = Join-Path $LocalAppDataPath "UnrealEditorWebUI"
$RunnerBase = Join-Path $ControlledRoot "actions-runners"
foreach ($ControlledDirectory in @($LocalAppDataPath, $ControlledRoot, $RunnerBase)) {
    if (-not (Test-Path -LiteralPath $ControlledDirectory)) {
        New-Item -ItemType Directory -Path $ControlledDirectory | Out-Null
    }
    $ControlledItem = Get-Item -LiteralPath $ControlledDirectory -Force
    if (-not $ControlledItem.PSIsContainer -or
        ($ControlledItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runner profile ancestors must be real non-reparse directories."
    }
}
$RunnerRoot = Join-Path $RunnerBase "$Wave-$Variant"
$RunnerRootFullPath = [System.IO.Path]::GetFullPath($RunnerRoot)
$ExpectedBasePath = [System.IO.Path]::GetFullPath($RunnerBase).TrimEnd('\') + '\'
if (-not ($RunnerRootFullPath + '\').StartsWith($ExpectedBasePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The runner root escaped the dedicated profile."
}
if (Test-Path -LiteralPath $RunnerRootFullPath) {
    throw "The one-job runner root already exists. Remove the completed registration through the documented cleanup flow first."
}
New-Item -ItemType Directory -Path $RunnerRootFullPath | Out-Null
$RunnerRootItem = Get-Item -LiteralPath $RunnerRootFullPath -Force
if (-not $RunnerRootItem.PSIsContainer -or
    ($RunnerRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The one-job runner root must be a real directory."
}

$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeArchivePath = Join-Path $RunnerRootFullPath $NodeArchiveName
$NodeDownloadUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName"
try {
    Invoke-WebRequest -UseBasicParsing -Uri $NodeDownloadUrl -OutFile $NodeArchivePath
    $ActualNodeSha256 = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualNodeSha256 -cne $NodeSha256) {
        throw "Node.js archive SHA-256 mismatch."
    }
    Expand-Archive -LiteralPath $NodeArchivePath -DestinationPath $RunnerRootFullPath
}
finally {
    if (Test-Path -LiteralPath $NodeArchivePath -PathType Leaf) {
        Remove-Item -LiteralPath $NodeArchivePath -Force
    }
}
$NodeRoot = Join-Path $RunnerRootFullPath "node-v$NodeVersion-win-x64"
$NodeExecutable = Join-Path $NodeRoot "node.exe"
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw "The verified Node.js archive did not contain node.exe."
}
$DetectedNodeVersion = @(& $NodeExecutable --version)
if ($LASTEXITCODE -ne 0 -or
    $DetectedNodeVersion.Count -ne 1 -or
    $DetectedNodeVersion[0] -cne "v$NodeVersion") {
    throw "The installed private Node.js runtime does not match the verified archive."
}
$NodeVersionValidator = Join-Path $PSScriptRoot "validate-node-version.mjs"
if (-not (Test-Path -LiteralPath $NodeVersionValidator -PathType Leaf)) {
    throw "Node.js version validator not found."
}
& $NodeExecutable $NodeVersionValidator
if ($LASTEXITCODE -ne 0) {
    throw "The pinned private Node.js runtime is outside the repository contract."
}

$VariantRegistryScript = Join-Path $PSScriptRoot "ue-release-variants.mjs"
if (-not (Test-Path -LiteralPath $VariantRegistryScript -PathType Leaf)) {
    throw "UE release variant registry script not found."
}
$MatrixText = @(& $NodeExecutable $VariantRegistryScript workflow-matrix)
if ($LASTEXITCODE -ne 0 -or $MatrixText.Count -ne 1) {
    throw "Could not decode the checked-in UE release variant registry."
}
$Matrix = $MatrixText[0] | ConvertFrom-Json
$VariantEntries = @($Matrix.include | Where-Object { $_.variant_id -ceq $Variant })
if ($VariantEntries.Count -ne 1 -or @($Matrix.include).Count -ne 3) {
    throw "The checked-in registry does not contain the closed three-variant set."
}
$VariantEntry = $VariantEntries[0]

$RunnerName = "unreal-editor-webui-$Wave-$Variant"
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
foreach ($IdentityDocument in @($BuildVersion, $EditorVersion)) {
    foreach ($Field in $ExpectedIdentity.Keys) {
        if ($IdentityDocument.$Field -cne $ExpectedIdentity[$Field]) {
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
        throw "$Variant requires a clean dedicated profile without a user-global Unreal init script."
    }
}

$RunnerArchiveName = "actions-runner-win-x64-$RunnerVersion.zip"
$RunnerArchivePath = Join-Path $RunnerRootFullPath $RunnerArchiveName
$RunnerDownloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$RunnerArchiveName"
try {
    Invoke-WebRequest -UseBasicParsing -Uri $RunnerDownloadUrl -OutFile $RunnerArchivePath
    $ActualRunnerSha256 = (Get-FileHash -LiteralPath $RunnerArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualRunnerSha256 -cne $RunnerSha256) {
        throw "GitHub Actions runner SHA-256 mismatch."
    }
    Expand-Archive -LiteralPath $RunnerArchivePath -DestinationPath $RunnerRootFullPath
}
finally {
    if (Test-Path -LiteralPath $RunnerArchivePath -PathType Leaf) {
        Remove-Item -LiteralPath $RunnerArchivePath -Force
    }
}

$ConfigPath = Join-Path $RunnerRootFullPath "config.cmd"
$RunnerListener = Join-Path $RunnerRootFullPath "bin/Runner.Listener.exe"
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $RunnerListener -PathType Leaf)) {
    throw "The verified runner archive did not contain the expected executables."
}
$VersionOutput = @(& $RunnerListener --version)
$VersionExitCode = $LASTEXITCODE
$InstalledVersionMatch = [regex]::Match(($VersionOutput -join "`n"), "(?<!\d)\d+\.\d+\.\d+(?!\d)")
if ($VersionExitCode -ne 0 -or
    -not $InstalledVersionMatch.Success -or
    $InstalledVersionMatch.Value -cne $RunnerVersion) {
    throw "The installed runner version does not match the verified archive version."
}

if ($null -eq $RegistrationToken) {
    $RegistrationToken = Read-Host "Short-lived GitHub runner registration token" -AsSecureString
}
if ($null -eq $RegistrationToken -or $RegistrationToken.Length -eq 0) {
    throw "A non-empty short-lived registration token is required."
}

$TokenPointer = [IntPtr]::Zero
$PlainRegistrationToken = $null
try {
    $TokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RegistrationToken)
    $PlainRegistrationToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($TokenPointer)
    if ([string]::IsNullOrWhiteSpace($PlainRegistrationToken)) {
        throw "A non-empty short-lived registration token is required."
    }

    Push-Location $RunnerRootFullPath
    try {
        $ConfigArguments = @(
            "--url", $RepoUrl,
            "--token", $PlainRegistrationToken,
            "--name", $RunnerName,
            "--no-default-labels",
            "--labels", $Labels,
            "--work", "_work",
            "--unattended",
            "--disableupdate",
            "--ephemeral"
        )
        & $ConfigPath @ConfigArguments
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub runner configuration failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $PlainRegistrationToken = $null
    if ($TokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($TokenPointer)
    }
}

$BootstrapEvidencePath = Join-Path $RunnerRootFullPath "UEWebUIRunnerBootstrap.json"
[ordered]@{
    schemaVersion = 1
    variant = $Variant
    wave = $Wave
    ephemeral = $true
    noDefaultLabels = $true
    runnerVersion = $RunnerVersion
    runnerArchiveSha256 = "sha256:$RunnerSha256"
    nodeVersion = $NodeVersion
    nodeArchiveSha256 = "sha256:$NodeSha256"
    dedicatedStandardUser = $true
    interactiveDesktopValidated = $true
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $BootstrapEvidencePath -Encoding UTF8

Write-Output "Configured one verified ephemeral GUI listener for $Wave/$Variant."
Write-Output "Use scripts/start-ue-runner.ps1 from this same interactive dedicated account when the protected environment is ready."
