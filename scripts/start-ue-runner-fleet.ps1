param(
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

$StartScript = Join-Path $PSScriptRoot "start-ue-runner.ps1"
$WindowsPowerShell = Join-Path $PSHOME "powershell.exe"
$TaskKill = Join-Path $env:SystemRoot "System32/taskkill.exe"
foreach ($RequiredFile in @($StartScript, $WindowsPowerShell, $TaskKill)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "A required fleet launcher file is missing."
    }
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
$Launches = @()
foreach ($Variant in @("ue54", "ue55", "ue58")) {
    $RunnerRoot = Join-Path $RunnerBase "$Wave-$Variant"
    foreach ($RequiredRunnerFile in @(".runner", "run.cmd", "UEWebUIRunnerBootstrap.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $RunnerRoot $RequiredRunnerFile) -PathType Leaf)) {
            throw "All three verified one-job registrations for the requested wave must exist before launch."
        }
    }
    $Bootstrap = Get-Content -LiteralPath (Join-Path $RunnerRoot "UEWebUIRunnerBootstrap.json") -Raw | ConvertFrom-Json
    if ($Bootstrap.schemaVersion -ne 2 -or
        [string]$Bootstrap.variant -cne $Variant -or
        [string]$Bootstrap.wave -cne $Wave -or
        [string]$Bootstrap.state -cne "configured" -or
        $Bootstrap.ephemeral -ne $true -or
        $Bootstrap.noDefaultLabels -ne $true) {
        throw "A one-job runner bootstrap identity is invalid."
    }
    $Launches += [pscustomobject]@{ Wave = $Wave; Variant = $Variant }
}
if ($Launches.Count -ne 3) {
    throw "A protected runner wave must contain exactly three one-job listeners."
}

$Processes = @()
$FleetCompleted = $false
try {
    foreach ($Launch in $Launches) {
        $Arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"' + $StartScript.Replace('"', '\"') + '"'),
            "-Wave", $Launch.Wave,
            "-Variant", $Launch.Variant
        ) -join " "
        $Processes += Start-Process `
            -FilePath $WindowsPowerShell `
            -ArgumentList $Arguments `
            -WindowStyle Hidden `
            -PassThru
    }

    Write-Output "Started three hidden, interactive, one-job UE listeners for the requested wave."
    while (@($Processes | Where-Object { -not $_.HasExited }).Count -ne 0) {
        Start-Sleep -Milliseconds 500
        foreach ($Process in $Processes) {
            $Process.Refresh()
        }
        $FailedProcesses = @($Processes | Where-Object { $_.HasExited -and $_.ExitCode -ne 0 })
        if ($FailedProcesses.Count -ne 0) {
            throw "A protected one-job listener exited unsuccessfully."
        }
    }
    $FailedCount = @($Processes | Where-Object { $_.ExitCode -ne 0 }).Count
    if ($FailedCount -ne 0) {
        throw "$FailedCount protected one-job listeners exited unsuccessfully."
    }
    $FleetCompleted = $true
}
finally {
    if (-not $FleetCompleted) {
        $CleanupFailureCount = 0
        foreach ($Process in $Processes) {
            $Process.Refresh()
            if (-not $Process.HasExited) {
                # Stop only the exact wrapper PID and its child tree so an
                # interrupted controller cannot leave a hidden listener online.
                & $TaskKill /PID $Process.Id /T /F | Out-Null
                if ($LASTEXITCODE -ne 0 -or -not $Process.WaitForExit(5000)) {
                    $CleanupFailureCount += 1
                }
            }
        }
        if ($CleanupFailureCount -ne 0) {
            throw "Failed to stop $CleanupFailureCount exact listener process trees."
        }
    }
}
Write-Output "All three protected one-job listeners completed."
