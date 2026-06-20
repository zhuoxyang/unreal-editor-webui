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

    $excludeDirs = @(
        (Join-Path $RootDir ".git"),
        (Join-Path $RootDir "Binaries"),
        (Join-Path $RootDir "DerivedDataCache"),
        (Join-Path $RootDir "Intermediate"),
        (Join-Path $RootDir "Saved"),
        (Join-Path $RootDir "frontend/node_modules"),
        (Join-Path $RootDir "frontend/dist"),
        (Join-Path $RootDir "node_modules"),
        (Join-Path $RootDir "Python/__pycache__"),
        (Join-Path $RootDir "tests/__pycache__")
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
