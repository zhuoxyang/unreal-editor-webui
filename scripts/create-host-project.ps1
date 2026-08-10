param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,

    [Parameter(Mandatory = $true)]
    [string]$PluginSourceDir,

    [ValidatePattern("^5\.\d+$")]
    [string]$EngineAssociation = "5.8",

    [string]$ToolCatalogTemplate = "",

    [string]$ToolCatalogMarker = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PluginSourceDir -PathType Container)) {
    throw "Plugin source directory not found: $PluginSourceDir"
}

$HasToolCatalogTemplate = -not [string]::IsNullOrWhiteSpace($ToolCatalogTemplate)
$HasToolCatalogMarker = -not [string]::IsNullOrWhiteSpace($ToolCatalogMarker)
if ($HasToolCatalogTemplate -xor $HasToolCatalogMarker) {
    throw "ToolCatalogTemplate and ToolCatalogMarker must be provided together."
}

$RenderedToolCatalog = $null
if ($HasToolCatalogTemplate) {
    if ($ToolCatalogMarker -cnotmatch "^[0-9a-f]{32}$") {
        throw "ToolCatalogMarker must be exactly 32 lowercase hexadecimal characters."
    }
    if (-not (Test-Path -LiteralPath $ToolCatalogTemplate -PathType Leaf)) {
        throw "Tool catalog template not found: $ToolCatalogTemplate"
    }

    $ToolCatalogTemplatePath = (Resolve-Path -LiteralPath $ToolCatalogTemplate).Path
    $ToolCatalogTemplateItem = Get-Item -LiteralPath $ToolCatalogTemplatePath
    if (($ToolCatalogTemplateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Tool catalog template must not be a reparse point: $ToolCatalogTemplatePath"
    }

    $StrictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $ToolCatalogTemplateText = [System.IO.File]::ReadAllText($ToolCatalogTemplatePath, $StrictUtf8)
    $ToolCatalogPlaceholder = "__UE_WEBUI_CATALOG_MARKER__"
    if (-not $ToolCatalogTemplateText.Contains($ToolCatalogPlaceholder)) {
        throw "Tool catalog template does not contain the required marker placeholder."
    }

    $RenderedToolCatalog = $ToolCatalogTemplateText.Replace($ToolCatalogPlaceholder, $ToolCatalogMarker)
    if ($RenderedToolCatalog.Contains($ToolCatalogPlaceholder)) {
        throw "Tool catalog marker replacement was incomplete."
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($RenderedToolCatalog) -gt (128 * 1024)) {
        throw "Rendered tool catalog exceeds the 128 KiB runtime limit."
    }

    try {
        $ToolCatalogDocument = $RenderedToolCatalog | ConvertFrom-Json
    }
    catch {
        throw "Rendered tool catalog is not valid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $ToolCatalogDocument -or
        -not ($ToolCatalogDocument.PSObject.Properties.Name -contains "schemaVersion") -or
        -not ($ToolCatalogDocument.schemaVersion -is [int]) -or
        $ToolCatalogDocument.schemaVersion -ne 1) {
        throw "Rendered tool catalog must use schemaVersion 1."
    }
}

$ProjectDirPath = [System.IO.Path]::GetFullPath($ProjectDir)
$PluginDest = Join-Path $ProjectDirPath "Plugins/UnrealEditorWebUI"
$ProjectPath = Join-Path $ProjectDirPath "HostProject.uproject"

New-Item -ItemType Directory -Path $PluginDest -Force | Out-Null

& robocopy $PluginSourceDir $PluginDest /MIR /XD "__pycache__" "Intermediate" "Saved" "DerivedDataCache" /XF ".DS_Store" | Out-Null
if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$ProjectJson = [ordered]@{
    FileVersion = 3
    EngineAssociation = $EngineAssociation
    Category = ""
    Description = "Temporary host project for UnrealEditorWebUI CI validation"
    Plugins = @(
        @{ Name = "UnrealEditorWebUI"; Enabled = $true },
        @{ Name = "PythonScriptPlugin"; Enabled = $true },
        @{ Name = "WebBrowserWidget"; Enabled = $true }
    )
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $ProjectPath -Value $ProjectJson -Encoding UTF8
if ($HasToolCatalogTemplate) {
    $ToolCatalogPath = Join-Path $ProjectDirPath "Config/UnrealEditorWebUI/ToolCatalog.json"
    $ToolCatalogDir = Split-Path -Parent $ToolCatalogPath
    New-Item -ItemType Directory -Path $ToolCatalogDir -Force | Out-Null
    [System.IO.File]::WriteAllText(
        $ToolCatalogPath,
        $RenderedToolCatalog,
        [System.Text.UTF8Encoding]::new($false))
}
Write-Output $ProjectPath
