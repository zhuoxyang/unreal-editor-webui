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

    [Parameter(Mandatory = $true)]
    [System.Management.Automation.PSCredential]$DedicatedUserCredential
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    return '"' + $Value.Replace('"', '\"') + '"'
}

$SetupScript = Join-Path $PSScriptRoot "setup-ue-runner.ps1"
if (-not (Test-Path -LiteralPath $SetupScript -PathType Leaf)) {
    throw "The dedicated-user setup script is missing."
}
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WindowsPowerShell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) {
    throw "Windows PowerShell executable not found under PSHOME."
}

# The short-lived registration token is intentionally not accepted by this
# controller. The child prompts for it inside the target profile, so the
# controller-to-child handoff never serializes it into argv, environment, or a
# file. The child converts it only for the official config.cmd invocation.
$ChildArguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (ConvertTo-ProcessArgument -Value $SetupScript),
    "-RepoUrl", (ConvertTo-ProcessArgument -Value $RepoUrl),
    "-Variant", $Variant,
    "-Wave", $Wave,
    "-DedicatedRunnerAccount"
) -join " "

$Child = Start-Process `
    -FilePath $WindowsPowerShell `
    -ArgumentList $ChildArguments `
    -Credential $DedicatedUserCredential `
    -LoadUserProfile `
    -WorkingDirectory $RepositoryRoot `
    -WindowStyle Normal `
    -Wait `
    -PassThru
if ($Child.ExitCode -ne 0) {
    throw "Dedicated-user runner setup failed with exit code $($Child.ExitCode)."
}

Write-Output "Dedicated-user runner setup completed."
