param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "rez")]
    [string]$Wave,

    [Parameter(Mandatory = $true)]
    [switch]$GitHubRegistrationsRemoved
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $PendingDirectories = New-Object 'System.Collections.Generic.Stack[string]'
    $PendingDirectories.Push($LiteralPath)
    while ($PendingDirectories.Count -ne 0) {
        $CurrentDirectory = $PendingDirectories.Pop()
        foreach ($Child in @(Get-ChildItem -LiteralPath $CurrentDirectory -Force -ErrorAction Stop)) {
            if (($Child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Runner cleanup refuses a tree containing a reparse point."
            }
            if ($Child.PSIsContainer) {
                $PendingDirectories.Push($Child.FullName)
            }
        }
    }
}

if (-not $GitHubRegistrationsRemoved.IsPresent) {
    throw "Confirm that all three ephemeral registrations completed or were removed through GitHub before local cleanup."
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
$RunnerBaseFullPath = [System.IO.Path]::GetFullPath($RunnerBase)
$RunnerBasePrefix = $RunnerBaseFullPath.TrimEnd('\') + '\'
$Targets = @()
foreach ($Variant in @("ue54", "ue55", "ue58")) {
    $Target = Join-Path $RunnerBaseFullPath "$Wave-$Variant"
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
        throw "All three exact runner roots must exist before wave cleanup."
    }
    $TargetPath = (Resolve-Path -LiteralPath $Target).Path
    $TargetItem = Get-Item -LiteralPath $TargetPath -Force
    if (-not ($TargetPath + '\').StartsWith($RunnerBasePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $TargetPath) -cne "$Wave-$Variant" -or
        ($TargetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "A runner cleanup target is unsafe."
    }
    Assert-NoReparseTree -LiteralPath $TargetPath
    $BootstrapPath = Join-Path $TargetPath "UEWebUIRunnerBootstrap.json"
    if (-not (Test-Path -LiteralPath $BootstrapPath -PathType Leaf)) {
        throw "A runner cleanup target has no bootstrap identity."
    }
    $Bootstrap = Get-Content -LiteralPath $BootstrapPath -Raw | ConvertFrom-Json
    if ($Bootstrap.schemaVersion -ne 1 -or
        [string]$Bootstrap.variant -cne $Variant -or
        [string]$Bootstrap.wave -cne $Wave -or
        $Bootstrap.ephemeral -ne $true) {
        throw "A runner cleanup target has an invalid bootstrap identity."
    }
    $Targets += $TargetPath
}

$RunnerProcesses = @(
    Get-Process -Name "Runner.Listener", "Runner.Worker", "Runner.PluginHost" -ErrorAction SilentlyContinue
)
foreach ($RunnerProcess in $RunnerProcesses) {
    $ListenerPath = $null
    try {
        $ListenerPath = $RunnerProcess.Path
    }
    catch {
        throw "Could not verify whether a runner listener is still using the cleanup targets."
    }
    foreach ($Target in $Targets) {
        $TargetPrefix = $Target.TrimEnd('\') + '\'
        if (-not [string]::IsNullOrWhiteSpace($ListenerPath) -and
            $ListenerPath.StartsWith($TargetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "A runner listener is still using the requested cleanup wave."
        }
    }
}

foreach ($Target in $Targets) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
Write-Output "Removed three verified local runner roots for the completed wave."
