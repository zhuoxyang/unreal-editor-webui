[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [Parameter(Mandatory = $true)]
    [string]$PluginDirectory,

    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [string]$CommandNamespace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$HelperPath = Join-Path $PSScriptRoot "add-tool-pack.mjs"
if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw "add-tool-pack helper not found: $HelperPath"
}

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $NodeCommand) {
    throw "Node.js is required. Install the repository-supported Node version and try again."
}

$NodeArguments = @(
    $HelperPath,
    "--plugin-directory",
    $PluginDirectory,
    "--id",
    $Id,
    "--command-namespace",
    $CommandNamespace
)

$ShouldApply = $PSCmdlet.ShouldProcess(
    $PluginDirectory,
    "Add Tool Pack '$Id' with namespace '$CommandNamespace'")
if (-not $ShouldApply) {
    $NodeArguments += "--dry-run"
}

& $NodeCommand.Source @NodeArguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
