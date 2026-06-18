param(
    [Parameter(Mandatory = $true)]
    [string]$RunUAT,

    [Parameter(Mandatory = $true)]
    [string]$PackageDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $RunUAT -PathType Leaf)) {
    throw "RunUAT path not found: $RunUAT"
}

$RunUATPath = (Resolve-Path -LiteralPath $RunUAT).Path
$RootDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("UnrealEditorWebUI-" + [System.Guid]::NewGuid().ToString("N"))
$PluginStage = Join-Path $StagingDir "UnrealEditorWebUI"
$PluginDescriptor = Join-Path $PluginStage "UnrealEditorWebUI.uplugin"

try {
    New-Item -ItemType Directory -Path $PluginStage -Force | Out-Null

    $excludeDirs = @(
        (Join-Path $RootDir ".git"),
        (Join-Path $RootDir "Binaries"),
        (Join-Path $RootDir "DerivedDataCache"),
        (Join-Path $RootDir "Intermediate"),
        (Join-Path $RootDir "Saved"),
        (Join-Path $RootDir "frontend/node_modules"),
        (Join-Path $RootDir "frontend/dist"),
        (Join-Path $RootDir "node_modules")
    )

    & robocopy $RootDir $PluginStage /MIR /XD $excludeDirs /XF ".DS_Store" | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    & $RunUATPath BuildPlugin `
        "-Plugin=$PluginDescriptor" `
        "-Package=$PackageDir" `
        -Rocket

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    if (Test-Path -LiteralPath $StagingDir) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force
    }
}
