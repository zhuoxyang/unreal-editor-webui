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
$LicenseFile = Join-Path $RootDir "LICENSE"
$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("UnrealEditorWebUI-" + [System.Guid]::NewGuid().ToString("N"))
$PluginStage = Join-Path $StagingDir "UnrealEditorWebUI"
$PluginDescriptor = Join-Path $PluginStage "UnrealEditorWebUI.uplugin"

try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is required to build the React frontend before packaging."
    }

    & node (Join-Path $PSScriptRoot "validate-node-version.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "The installed Node.js version does not satisfy frontend/package.json."
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
    if (-not (Test-Path -LiteralPath $LicenseFile -PathType Leaf)) {
        throw "Repository license not found: $LicenseFile"
    }

    New-Item -ItemType Directory -Path $PluginStage -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $RootDir "UnrealEditorWebUI.uplugin") -Destination $PluginDescriptor
    Copy-Item -LiteralPath $LicenseFile -Destination (Join-Path $PluginStage "LICENSE")

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

    $PackagedLicense = Join-Path $PackageDir "LICENSE"
    if (-not (Test-Path -LiteralPath $PackagedLicense -PathType Leaf)) {
        throw "Packaged plugin license missing: $PackagedLicense"
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PackagedLicense).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $LicenseFile).Hash) {
        throw "Packaged plugin license does not match the repository license."
    }
}
finally {
    if (Test-Path -LiteralPath $StagingDir) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force
    }
}
