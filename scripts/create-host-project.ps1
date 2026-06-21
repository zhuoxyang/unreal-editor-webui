param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,

    [Parameter(Mandatory = $true)]
    [string]$PluginSourceDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PluginSourceDir -PathType Container)) {
    throw "Plugin source directory not found: $PluginSourceDir"
}

$ProjectDirPath = [System.IO.Path]::GetFullPath($ProjectDir)
$PluginDest = Join-Path $ProjectDirPath "Plugins/UnrealEditorWebUI"
$ProjectPath = Join-Path $ProjectDirPath "HostProject.uproject"

New-Item -ItemType Directory -Path $PluginDest -Force | Out-Null

& robocopy $PluginSourceDir $PluginDest /MIR /XD "__pycache__" "Intermediate" "Saved" "DerivedDataCache" /XF ".DS_Store" | Out-Host
if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$ProjectJson = [ordered]@{
    FileVersion = 3
    EngineAssociation = "5.5"
    Category = ""
    Description = "Temporary host project for UnrealEditorWebUI CI validation"
    Plugins = @(
        @{ Name = "UnrealEditorWebUI"; Enabled = $true },
        @{ Name = "PythonScriptPlugin"; Enabled = $true },
        @{ Name = "WebBrowserWidget"; Enabled = $true }
    )
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $ProjectPath -Value $ProjectJson -Encoding UTF8
Write-Output $ProjectPath
