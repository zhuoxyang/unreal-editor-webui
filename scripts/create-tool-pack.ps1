[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [string]$CommandNamespace,

    [string]$OutputDirectory = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Name -cnotmatch "\A[A-Z][A-Za-z0-9]{1,63}\z") {
    throw "Name must start with an uppercase ASCII letter and contain only ASCII letters and digits (2-64 characters)."
}
if ($Name -match "\A(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\z") {
    throw "Name is reserved by Windows."
}
if ($Name -ieq "UnrealEditorWebUI") {
    throw "Name is reserved for the core plugin."
}
if ($Id.Length -gt 128 -or
    $Id -cnotmatch "\A[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\z") {
    throw "Id must be a lowercase reverse-DNS identifier (for example, com.studio.asset-tools)."
}
if ($CommandNamespace.Length -gt 128 -or
    $CommandNamespace -cnotmatch "\A[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\z") {
    throw "CommandNamespace must be a lowercase dotted identifier using ASCII letters, digits, and underscores."
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    throw "OutputDirectory must be an existing directory: $OutputDirectory"
}

$OutputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$OutputRootItem = Get-Item -LiteralPath $OutputRoot
if (($OutputRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "OutputDirectory must not be a reparse point: $OutputRoot"
}

$TargetDirectory = [System.IO.Path]::GetFullPath((Join-Path $OutputRoot $Name))
$PathComparison = if (
    [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
) {
    [System.StringComparison]::OrdinalIgnoreCase
}
else {
    [System.StringComparison]::Ordinal
}
$OutputRootComparisonKey = $OutputRootItem.FullName.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar)
$TargetParent = [System.IO.Directory]::GetParent($TargetDirectory)
if ($null -eq $TargetParent -or
    -not [System.String]::Equals(
        $TargetParent.FullName.TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar),
        $OutputRootComparisonKey,
        $PathComparison)) {
    throw "The generated Tool Pack path must remain inside OutputDirectory."
}
if (Test-Path -LiteralPath $TargetDirectory) {
    throw "Refusing to overwrite existing path: $TargetDirectory"
}

$PythonPackageSuffix = [System.Text.RegularExpressions.Regex]::Replace(
    $Name,
    "(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])",
    "_").ToLowerInvariant()
$PythonPackage = "ue_webui_toolpack_" + $PythonPackageSuffix
if ($PythonPackage -cnotmatch "\A[a-z][a-z0-9_]{1,255}\z") {
    throw "Name could not be converted to a safe Python package identifier."
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$StagingDirectory = Join-Path $OutputRoot (".create-tool-pack-" + [guid]::NewGuid().ToString("N"))
$StagingDirectory = [System.IO.Path]::GetFullPath($StagingDirectory)
$StagingParent = [System.IO.Directory]::GetParent($StagingDirectory)
if ($null -eq $StagingParent -or
    -not [System.String]::Equals(
        $StagingParent.FullName.TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar),
        $OutputRootComparisonKey,
        $PathComparison)) {
    throw "The private staging path must remain inside OutputDirectory."
}

try {
    New-Item -ItemType Directory -Path $StagingDirectory -ErrorAction Stop | Out-Null

    $ManifestDirectory = Join-Path $StagingDirectory "Content/UnrealEditorWebUI"
    $PythonDirectory = Join-Path $StagingDirectory ("Content/Python/" + $PythonPackage)
    New-Item -ItemType Directory -Path $ManifestDirectory -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $PythonDirectory -ErrorAction Stop | Out-Null

    $PluginDescriptor = [ordered]@{
        FileVersion = 3
        Version = 1
        VersionName = "1.0.0"
        FriendlyName = ([System.Text.RegularExpressions.Regex]::Replace($Name, "(?<=[a-z0-9])(?=[A-Z])", " "))
        Description = "Content-only Tool Pack for Unreal Editor WebUI."
        Category = "Editor"
        CanContainContent = $true
        NoCode = $true
        Installed = $false
        Plugins = @(
            [ordered]@{
                Name = "UnrealEditorWebUI"
                Enabled = $true
            }
        )
    }
    $Manifest = [ordered]@{
        schemaVersion = 1
        id = $Id
        requiredCoreApi = 1
        pythonPackage = $PythonPackage
        commandNamespace = $CommandNamespace
    }

    $PluginJson = ($PluginDescriptor | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    $ManifestJson = ($Manifest | ConvertTo-Json -Depth 3) + [Environment]::NewLine
    [System.IO.File]::WriteAllText(
        (Join-Path $StagingDirectory ($Name + ".uplugin")),
        $PluginJson,
        $Utf8NoBom)
    [System.IO.File]::WriteAllText(
        (Join-Path $ManifestDirectory "ToolPack.json"),
        $ManifestJson,
        $Utf8NoBom)

    $InitSource = '"""Commands provided by the ' + $Name + ' Tool Pack."""' + [Environment]::NewLine
    [System.IO.File]::WriteAllText(
        (Join-Path $PythonDirectory "__init__.py"),
        $InitSource,
        $Utf8NoBom)

    $CommandName = $CommandNamespace + ".ping"
    $CommandsSource = @"
from __future__ import annotations

from typing import Any

from unreal_editor_webui_sdk import command


@command(
    "$CommandName",
    description="Verify that the $Name Tool Pack is loaded.",
    permission="read",
    category="$Name",
    tags=["tool-pack", "smoke"],
    result_type="json",
)
def ping(payload: dict[str, Any]) -> dict[str, Any]:
    return {"message": "pong", "echo": payload}
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $PythonDirectory "commands.py"),
        $CommandsSource,
        $Utf8NoBom)

    [System.IO.Directory]::Move($StagingDirectory, $TargetDirectory)
}
finally {
    if (Test-Path -LiteralPath $StagingDirectory -PathType Container) {
        Remove-Item -LiteralPath $StagingDirectory -Recurse -Force
    }
}

Write-Output $TargetDirectory
