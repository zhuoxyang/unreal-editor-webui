param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ue54", "ue55", "ue58")]
    [string]$Variant,

    [Parameter(Mandatory = $true)]
    [ValidateSet("UE54-Win64", "UE55-Win64", "UE58-Win64")]
    [string]$ReleaseVariant,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[1-9][0-9]*$")]
    [string]$RunId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[1-9][0-9]*$")]
    [string]$RunAttempt,

    [Parameter(Mandatory = $true)]
    [string]$RunnerTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedReleaseVariants = @{
    ue54 = "UE54-Win64"
    ue55 = "UE55-Win64"
    ue58 = "UE58-Win64"
}
if ($ExpectedReleaseVariants[$Variant] -cne $ReleaseVariant) {
    throw "The runner-diagnostics variant identity is inconsistent."
}

function Test-RegularFile {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return $false
    }
    $Item = Get-Item -LiteralPath $LiteralPath -Force
    return ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
}

$RunnerTempPath = (Resolve-Path -LiteralPath $RunnerTemp).Path
$RunSuffix = "$RunId-$RunAttempt-$Variant"
$OutputDirectory = Join-Path $RunnerTempPath "UnrealEditorWebUI-RunnerDiagnostics-$RunSuffix"
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "The allowlisted runner-diagnostics output is not fresh."
}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$OutputDirectoryPath = (Resolve-Path -LiteralPath $OutputDirectory).Path
$ExpectedRunnerTempPrefix = $RunnerTempPath.TrimEnd('\') + '\'
if (-not ($OutputDirectoryPath + '\').StartsWith($ExpectedRunnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The allowlisted runner-diagnostics output escaped RUNNER_TEMP."
}

$PackageDirectory = Join-Path $RunnerTempPath "UnrealEditorWebUI-Package-$RunSuffix"
$HostProjectDirectory = Join-Path $RunnerTempPath "UnrealEditorWebUI-HostProject-$RunSuffix"
$AutomationToolDirectory = Join-Path $RunnerTempPath "UnrealEditorWebUI-AutomationToolLogs-$RunSuffix"
$BrowserReportDirectory = Join-Path $RunnerTempPath "UnrealEditorWebUI-BrowserAutomationReport-$RunSuffix"
$BuildPluginConsoleLog = Join-Path $RunnerTempPath "UnrealEditorWebUI-BuildPlugin-$RunSuffix.log"
$AutomationLog = Join-Path $RunnerTempPath "UnrealEditorWebUI-Automation-$RunSuffix.log"
$PackagedSmokeResult = Join-Path $RunnerTempPath "UnrealEditorWebUI-PackagedBridgeSmoke-$RunSuffix.json"
$SettingsLog = Join-Path $RunnerTempPath "UnrealEditorWebUI-SettingsSmoke-$RunSuffix.log"
$BrowserLog = Join-Path $RunnerTempPath "UnrealEditorWebUI-BrowserAutomation-$RunSuffix.log"

$AutomationToolLogCount = 0
if (Test-Path -LiteralPath $AutomationToolDirectory -PathType Container) {
    $AutomationToolLogCount = @(
        Get-ChildItem -LiteralPath $AutomationToolDirectory -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 }
    ).Count
}
$BrowserReportFileCount = 0
if (Test-Path -LiteralPath $BrowserReportDirectory -PathType Container) {
    $BrowserReportFileCount = @(
        Get-ChildItem -LiteralPath $BrowserReportDirectory -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 }
    ).Count
}

$Diagnostics = [ordered]@{
    schemaVersion = 1
    variant = $Variant
    releaseVariant = $ReleaseVariant
    run = [ordered]@{
        id = $RunId
        attempt = [int]$RunAttempt
    }
    privacy = [ordered]@{
        allowlistedFieldsOnly = $true
        rawLogsUploaded = $false
        environmentDumpUploaded = $false
        registrationMaterialUploaded = $false
        machinePathsUploaded = $false
        userIdentityUploaded = $false
    }
    evidencePresence = [ordered]@{
        buildPluginConsole = (Test-RegularFile -LiteralPath $BuildPluginConsoleLog)
        automationToolLogCount = $AutomationToolLogCount
        packageDescriptor = (Test-RegularFile -LiteralPath (Join-Path $PackageDirectory "UnrealEditorWebUI.uplugin"))
        packageSourceManifest = (Test-RegularFile -LiteralPath (Join-Path $PackageDirectory "SourceManifest.json"))
        packageModule = (Test-RegularFile -LiteralPath (Join-Path $PackageDirectory "Binaries/Win64/UnrealEditor-UnrealEditorWebUI.dll"))
        hostProjectCreated = (Test-Path -LiteralPath $HostProjectDirectory -PathType Container)
        automationLog = (Test-RegularFile -LiteralPath $AutomationLog)
        packagedSmokeResult = (Test-RegularFile -LiteralPath $PackagedSmokeResult)
        settingsLog = (Test-RegularFile -LiteralPath $SettingsLog)
        browserLog = (Test-RegularFile -LiteralPath $BrowserLog)
        browserReportFileCount = $BrowserReportFileCount
    }
}

$OutputPath = Join-Path $OutputDirectoryPath "RunnerDiagnostics.json"
$Diagnostics | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output $OutputPath
