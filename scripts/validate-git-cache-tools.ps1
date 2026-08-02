param(
    [switch]$ExportToGitHubPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProgramFilesRoot = if (-not [string]::IsNullOrWhiteSpace($env:ProgramW6432)) {
    $env:ProgramW6432
}
else {
    $env:ProgramFiles
}
if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) {
    throw "The 64-bit Program Files directory is not available; Git for Windows cannot be located safely."
}

$GitUsrBin = Join-Path $ProgramFilesRoot "Git/usr/bin"
$TarPath = Join-Path $GitUsrBin "tar.exe"
$GzipPath = Join-Path $GitUsrBin "gzip.exe"

foreach ($RequiredTool in @($TarPath, $GzipPath)) {
    if (-not (Test-Path -LiteralPath $RequiredTool -PathType Leaf)) {
        throw "Required Git for Windows cache tool not found: $RequiredTool"
    }
}

$OriginalPath = $env:Path
if ([string]::IsNullOrWhiteSpace($OriginalPath)) {
    throw "PATH is empty; Git cache tools cannot be exposed safely."
}
$NormalizedGitUsrBin = $GitUsrBin.TrimEnd("\")
$OtherPathEntries = @(
    $OriginalPath.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
        Where-Object {
            -not ($_.Trim().Trim([char]'"').TrimEnd("\").Equals(
                $NormalizedGitUsrBin,
                [System.StringComparison]::OrdinalIgnoreCase
            ))
        }
)
$env:Path = (@($GitUsrBin) + $OtherPathEntries) -join ";"

$TempBase = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [System.IO.Path]::GetTempPath()
}
else {
    $env:RUNNER_TEMP
}
$ProbeRoot = Join-Path $TempBase ("UnrealEditorWebUI-GitCacheProbe-" + [System.Guid]::NewGuid().ToString("N"))
$PayloadName = "payload.txt"
$PayloadPath = Join-Path $ProbeRoot $PayloadName
$ArchiveName = "cache-probe.tar.gz"
$ArchivePath = Join-Path $ProbeRoot $ArchiveName
$LocationPushed = $false

try {
    New-Item -ItemType Directory -Path $ProbeRoot | Out-Null
    Set-Content -LiteralPath $PayloadPath -Value "git-cache-probe" -Encoding Ascii -NoNewline

    & $TarPath --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Git tar version probe failed with exit code $LASTEXITCODE."
    }

    & $GzipPath --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Git gzip version probe failed with exit code $LASTEXITCODE."
    }

    $ResolvedGzip = @(Get-Command gzip.exe -CommandType Application -ErrorAction Stop)[0].Source
    if (-not ([System.IO.Path]::GetFullPath($ResolvedGzip).Equals(
        [System.IO.Path]::GetFullPath($GzipPath),
        [System.StringComparison]::OrdinalIgnoreCase
    ))) {
        throw "PATH resolves gzip.exe to '$ResolvedGzip', expected '$GzipPath'."
    }

    Push-Location $ProbeRoot
    $LocationPushed = $true

    # Git's GNU tar treats a Windows drive colon in an archive argument as a
    # remote host separator, so keep both probe arguments relative to the
    # temporary working directory.
    & $TarPath --use-compress-program gzip -cf $ArchiveName $PayloadName
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        throw "Git tar could not create a gzip-compressed cache probe (exit code $LASTEXITCODE)."
    }

    $ArchiveEntries = @(& $TarPath --use-compress-program gzip -tf $ArchiveName)
    if ($LASTEXITCODE -ne 0) {
        throw "Git tar could not read the gzip-compressed cache probe (exit code $LASTEXITCODE)."
    }
    if ($ArchiveEntries.Count -ne 1 -or $ArchiveEntries[0].TrimStart([char[]]"./") -ne $PayloadName) {
        throw "Git tar cache probe contained unexpected entries: $($ArchiveEntries -join ', ')"
    }
}
finally {
    if ($LocationPushed) {
        Pop-Location
    }
    $env:Path = $OriginalPath

    if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
        [System.IO.File]::Delete($ArchivePath)
    }
    if (Test-Path -LiteralPath $PayloadPath -PathType Leaf) {
        [System.IO.File]::Delete($PayloadPath)
    }
    if (Test-Path -LiteralPath $ProbeRoot -PathType Container) {
        [System.IO.Directory]::Delete($ProbeRoot, $false)
    }
}

if ($ExportToGitHubPath) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_PATH)) {
        throw "GITHUB_PATH is required when -ExportToGitHubPath is used."
    }

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText(
        $env:GITHUB_PATH,
        "$GitUsrBin$([System.Environment]::NewLine)",
        $Utf8NoBom
    )
}

Write-Output $GitUsrBin
