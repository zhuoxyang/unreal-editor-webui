param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,

    [Parameter(Mandatory = $true)]
    [string]$PluginSourceDir,

    [ValidatePattern("^5\.\d+$")]
    [string]$EngineAssociation = "5.8",

    [string]$ToolCatalogTemplate = "",

    [string]$ToolCatalogMarker = "",

    [string]$ToolPackSourceDirsJson = "[]"
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

$ToolPackSourceDirsText = $ToolPackSourceDirsJson.Trim()
if ($ToolPackSourceDirsText -notmatch "^\[" -or $ToolPackSourceDirsText -notmatch "\]$") {
    throw "ToolPackSourceDirsJson must be a JSON array of directory paths."
}
try {
    $DecodedToolPackSourceDirs = $ToolPackSourceDirsText | ConvertFrom-Json
}
catch {
    throw "ToolPackSourceDirsJson is not valid JSON: $($_.Exception.Message)"
}
$ToolPackSourceDirs = @()
if ($null -ne $DecodedToolPackSourceDirs) {
    $ToolPackSourceDirs = @($DecodedToolPackSourceDirs)
}

$StrictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$ToolPackInputs = @()
$ToolPackNames = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
foreach ($ToolPackSourceDir in $ToolPackSourceDirs) {
    if (-not ($ToolPackSourceDir -is [string])) {
        throw "ToolPackSourceDirsJson entries must be strings."
    }
    if ([string]::IsNullOrWhiteSpace($ToolPackSourceDir)) {
        throw "Tool Pack source directories must be non-empty."
    }
    if (-not (Test-Path -LiteralPath $ToolPackSourceDir -PathType Container)) {
        throw "Tool Pack source directory not found: $ToolPackSourceDir"
    }

    $ToolPackSourcePath = (Resolve-Path -LiteralPath $ToolPackSourceDir).Path
    $ToolPackSourceItem = Get-Item -LiteralPath $ToolPackSourcePath
    if (($ToolPackSourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Tool Pack source directory must not be a reparse point: $ToolPackSourcePath"
    }
    $ToolPackReparsePoint = Get-ChildItem -LiteralPath $ToolPackSourcePath -Force -Recurse |
        Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
        Select-Object -First 1
    if ($null -ne $ToolPackReparsePoint) {
        throw "Tool Pack source must not contain reparse points: $($ToolPackReparsePoint.FullName)"
    }

    $ToolPackDescriptorFiles = @(
        Get-ChildItem -LiteralPath $ToolPackSourcePath -File -Filter "*.uplugin"
    )
    if ($ToolPackDescriptorFiles.Count -ne 1) {
        throw "Tool Pack source must contain exactly one root .uplugin descriptor: $ToolPackSourcePath"
    }

    $ToolPackName = [System.IO.Path]::GetFileNameWithoutExtension($ToolPackDescriptorFiles[0].Name)
    if ($ToolPackName -notmatch "\A[A-Za-z][A-Za-z0-9_]{0,63}\z" -or
        $ToolPackName -ieq "UnrealEditorWebUI") {
        throw "Tool Pack plugin name is invalid or reserved: $ToolPackName"
    }
    if (-not $ToolPackNames.Add($ToolPackName)) {
        throw "Duplicate Tool Pack plugin name: $ToolPackName"
    }

    try {
        $ToolPackDescriptorText = [System.IO.File]::ReadAllText(
            $ToolPackDescriptorFiles[0].FullName,
            $StrictUtf8)
        $ToolPackDescriptor = $ToolPackDescriptorText | ConvertFrom-Json
    }
    catch {
        throw "Tool Pack descriptor is not valid strict UTF-8 JSON: $ToolPackName"
    }
    if ($null -eq $ToolPackDescriptor -or
        $ToolPackDescriptor.CanContainContent -ne $true) {
        throw "Tool Pack host plugin must set CanContainContent to true: $ToolPackName"
    }
    $CoreDependencies = @(
        $ToolPackDescriptor.Plugins |
            Where-Object { $_.Name -ceq "UnrealEditorWebUI" -and $_.Enabled -eq $true }
    )
    if ($CoreDependencies.Count -ne 1) {
        throw "Tool Pack must declare one enabled UnrealEditorWebUI plugin dependency: $ToolPackName"
    }

    $ToolPackManifestPath = Join-Path $ToolPackSourcePath "Content/UnrealEditorWebUI/ToolPack.json"
    if (-not (Test-Path -LiteralPath $ToolPackManifestPath -PathType Leaf)) {
        throw "Tool Pack manifest is missing from Content/UnrealEditorWebUI: $ToolPackName"
    }
    $ToolPackManifestInfo = Get-Item -LiteralPath $ToolPackManifestPath
    if ($ToolPackManifestInfo.Length -gt (64 * 1024)) {
        throw "Tool Pack manifest exceeds the 64 KiB runtime limit: $ToolPackName"
    }
    $ExpectedToolPackManifestKeys = @(
        "schemaVersion",
        "id",
        "requiredCoreApi",
        "pythonPackage",
        "commandNamespace"
    )
    try {
        $ToolPackManifestText = [System.IO.File]::ReadAllText($ToolPackManifestPath, $StrictUtf8)
        # Windows PowerShell's ConvertFrom-Json collapses duplicate properties. Scan every
        # JSON string token used as an object key, decode escapes such as \u0073, and reject
        # duplicate decoded names before allowing ConvertFrom-Json to materialize the object.
        $JsonObjectKeyPattern = '(?<!\\)(?<key>"(?:\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4}|[^"\\\x00-\x1F])*")\s*:'
        $DecodedManifestKeys = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::Ordinal)
        foreach ($KeyMatch in [regex]::Matches($ToolPackManifestText, $JsonObjectKeyPattern)) {
            $DecodedManifestKey = $KeyMatch.Groups["key"].Value | ConvertFrom-Json
            if (-not ($DecodedManifestKey -is [string]) -or
                -not $DecodedManifestKeys.Add($DecodedManifestKey)) {
                throw "Tool Pack manifest contains a duplicate decoded field."
            }
        }
        if ($DecodedManifestKeys.Count -ne $ExpectedToolPackManifestKeys.Count -or
            @($ExpectedToolPackManifestKeys | Where-Object { -not $DecodedManifestKeys.Contains($_) }).Count -ne 0) {
            throw "Tool Pack manifest must contain exactly the schema-v1 fields."
        }
        $ToolPackManifest = $ToolPackManifestText | ConvertFrom-Json
    }
    catch {
        throw "Tool Pack manifest is not valid strict UTF-8 JSON: $ToolPackName"
    }
    if ($null -eq $ToolPackManifest) {
        throw "Tool Pack manifest does not satisfy the schema-v1 host fixture contract: $ToolPackName"
    }
    $ToolPackManifestKeys = @($ToolPackManifest.PSObject.Properties.Name)
    $HasClosedToolPackManifest =
        $ToolPackManifestKeys.Count -eq $ExpectedToolPackManifestKeys.Count -and
        @($ExpectedToolPackManifestKeys | Where-Object { $ToolPackManifestKeys -cnotcontains $_ }).Count -eq 0
    if (-not $HasClosedToolPackManifest -or
        -not (($ToolPackManifest.schemaVersion -is [int]) -or ($ToolPackManifest.schemaVersion -is [long])) -or
        $ToolPackManifest.schemaVersion -ne 1 -or
        -not ($ToolPackManifest.id -is [string]) -or
        $ToolPackManifest.id.Length -gt 128 -or
        $ToolPackManifest.id -cnotmatch "\A[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\z" -or
        -not (($ToolPackManifest.requiredCoreApi -is [int]) -or ($ToolPackManifest.requiredCoreApi -is [long])) -or
        $ToolPackManifest.requiredCoreApi -ne 1 -or
        -not ($ToolPackManifest.pythonPackage -is [string]) -or
        $ToolPackManifest.pythonPackage.Length -gt 256 -or
        $ToolPackManifest.pythonPackage -cnotmatch "\A[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*\z" -or
        $ToolPackManifest.pythonPackage -ceq "unreal_editor_webui" -or
        $ToolPackManifest.pythonPackage.StartsWith("unreal_editor_webui.", [System.StringComparison]::Ordinal) -or
        $ToolPackManifest.pythonPackage.StartsWith("unreal_editor_webui_", [System.StringComparison]::Ordinal) -or
        -not ($ToolPackManifest.commandNamespace -is [string]) -or
        $ToolPackManifest.commandNamespace.Length -gt 128 -or
        $ToolPackManifest.commandNamespace -cnotmatch "\A[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\z") {
        throw "Tool Pack manifest does not satisfy the schema-v1 host fixture contract: $ToolPackName"
    }
    $ToolPackPackagePath = Join-Path (
        Join-Path $ToolPackSourcePath "Content/Python") (
            [string]$ToolPackManifest.pythonPackage -replace "\.", [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath (Join-Path $ToolPackPackagePath "__init__.py") -PathType Leaf)) {
        throw "Tool Pack pythonPackage must resolve to a package under Content/Python: $ToolPackName"
    }

    $ToolPackInputs += [PSCustomObject]@{
        Name = $ToolPackName
        SourcePath = $ToolPackSourcePath
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

foreach ($ToolPackInput in $ToolPackInputs) {
    $ToolPackDest = Join-Path $ProjectDirPath "Plugins/$($ToolPackInput.Name)"
    New-Item -ItemType Directory -Path $ToolPackDest -Force | Out-Null
    & robocopy $ToolPackInput.SourcePath $ToolPackDest /MIR /XD "__pycache__" "Intermediate" "Saved" "DerivedDataCache" /XF ".DS_Store" | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "Tool Pack robocopy failed for $($ToolPackInput.Name) with exit code $LASTEXITCODE"
    }
}

$ProjectPlugins = @(
    @{ Name = "UnrealEditorWebUI"; Enabled = $true },
    @{ Name = "PythonScriptPlugin"; Enabled = $true },
    @{ Name = "WebBrowserWidget"; Enabled = $true }
)
foreach ($ToolPackInput in $ToolPackInputs) {
    $ProjectPlugins += @{ Name = $ToolPackInput.Name; Enabled = $true }
}

$ProjectJson = [ordered]@{
    FileVersion = 3
    EngineAssociation = $EngineAssociation
    Category = ""
    Description = "Temporary host project for UnrealEditorWebUI CI validation"
    Plugins = $ProjectPlugins
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
