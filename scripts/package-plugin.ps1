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
$FrontendDir = Join-Path $RootDir "frontend"
$FrontendEntry = Join-Path $RootDir "Web/dist/index.html"
$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("UnrealEditorWebUI-" + [System.Guid]::NewGuid().ToString("N"))
$PluginStage = Join-Path $StagingDir "UnrealEditorWebUI"
$PluginDescriptor = Join-Path $PluginStage "UnrealEditorWebUI.uplugin"

try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is required to build the React frontend before packaging."
    }

    Push-Location $FrontendDir
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }

        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $FrontendEntry -PathType Leaf)) {
        throw "Frontend build did not create the expected entry point: $FrontendEntry"
    }

    New-Item -ItemType Directory -Path $PluginStage -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $RootDir "UnrealEditorWebUI.uplugin") -Destination $PluginDescriptor

    $pluginDirectories = @("Config", "Content", "Platforms", "Python", "Resources", "Shaders", "Source", "Web")
    foreach ($directoryName in $pluginDirectories) {
        $sourceDirectory = Join-Path $RootDir $directoryName
        if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
            continue
        }

        $destinationDirectory = Join-Path $PluginStage $directoryName
        & robocopy $sourceDirectory $destinationDirectory /MIR /XD "__pycache__" /XF ".DS_Store" "*.pyc" "*.pyo" | Out-Host
        if ($LASTEXITCODE -gt 7) {
            throw "robocopy failed for $directoryName with exit code $LASTEXITCODE"
        }
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
