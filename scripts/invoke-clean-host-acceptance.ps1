[CmdletBinding()]
param(
    [string]$CandidateRoot = "",

    [ValidateSet("candidate", "published", IgnoreCase = $false)]
    [string]$SourceKind = "candidate",

    [string]$ReleaseCommit = "",

    [string]$UE54Root = "C:\Program Files\Epic Games\UE_5.4",

    [string]$UE55Root = "C:\Program Files\Epic Games\UE_5.5",

    [string]$UE58Root = "C:\Program Files\Epic Games\UE_5.8",

    [string]$OutputParent = "",

    [ValidateRange(8192, 65536)]
    [int]$SandboxMemoryMB = 16384,

    [switch]$Launch,

    [switch]$Finalize,

    [string]$RunRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ReleaseTag = "v0.3.0"
$RepositoryName = "zhuoxyang/unreal-editor-webui"
$StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$MaximumControllerJsonBytes = 1MB
$MaximumControllerJsonNestingDepth = 64
$StrictControllerJsonNumberRegex = [regex]'\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
$MaximumCoreArchiveBytes = 128MB
$MaximumChecksumSidecarBytes = 512
$AllowedGuestFailureCodes = @(
    "guest_environment_preflight_failed",
    "guest_plan_validation_failed",
    "guest_artifact_validation_failed",
    "guest_matrix_preflight_failed",
    "guest_editor_execution_failed",
    "guest_evidence_emission_failed",
    "guest_internal_failed"
)
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$VariantRegistryPath = Join-Path $PSScriptRoot "ue-release-variants.json"
$GuestScriptPath = Join-Path $PSScriptRoot "run-clean-host-acceptance-guest.ps1"
$ExtractorPath = Join-Path $PSScriptRoot "extract-verified-artifact.py"
$EvidenceValidatorPath = Join-Path $PSScriptRoot "validate-clean-host-evidence.mjs"

function Fail([string]$Message) {
    throw "Clean-host acceptance failed: $Message"
}

function Assert-NoDuplicateJsonKeys([string]$Text, [string]$Label) {
    $Frames = New-Object System.Collections.Stack
    $Index = 0
    while ($Index -lt $Text.Length) {
        $Character = $Text[$Index]
        if ($Character -eq '"') {
            $Builder = New-Object System.Text.StringBuilder
            $Index++
            $Closed = $false
            while ($Index -lt $Text.Length) {
                $Character = $Text[$Index]
                if ($Character -eq '"') {
                    $Closed = $true
                    $Index++
                    break
                }
                if ([int][char]$Character -lt 0x20) {
                    Fail "$Label contains an invalid JSON string."
                }
                if ($Character -ne '\') {
                    $Builder.Append($Character) | Out-Null
                    $Index++
                    continue
                }
                $Index++
                if ($Index -ge $Text.Length) {
                    Fail "$Label contains an incomplete JSON escape."
                }
                $Escape = $Text[$Index]
                if ($Escape -eq 'u') {
                    if ($Index + 4 -ge $Text.Length) {
                        Fail "$Label contains an incomplete JSON Unicode escape."
                    }
                    $Hex = $Text.Substring($Index + 1, 4)
                    if ($Hex -notmatch '^[0-9A-Fa-f]{4}$') {
                        Fail "$Label contains an invalid JSON Unicode escape."
                    }
                    $Builder.Append([char][Convert]::ToInt32($Hex, 16)) | Out-Null
                    $Index += 5
                    continue
                }
                switch ($Escape) {
                    '"' { $Decoded = '"' }
                    '\' { $Decoded = '\' }
                    '/' { $Decoded = '/' }
                    'b' { $Decoded = [char]0x0008 }
                    'f' { $Decoded = [char]0x000C }
                    'n' { $Decoded = [char]0x000A }
                    'r' { $Decoded = [char]0x000D }
                    't' { $Decoded = [char]0x0009 }
                    default { Fail "$Label contains an invalid JSON escape." }
                }
                $Builder.Append($Decoded) | Out-Null
                $Index++
            }
            if (-not $Closed) {
                Fail "$Label contains an unterminated JSON string."
            }
            $Probe = $Index
            while ($Probe -lt $Text.Length -and [char]::IsWhiteSpace($Text[$Probe])) {
                $Probe++
            }
            if ($Probe -lt $Text.Length -and $Text[$Probe] -eq ':') {
                if ($Frames.Count -eq 0 -or $Frames.Peek().type -cne "object") {
                    Fail "$Label contains a property outside an object."
                }
                $Key = $Builder.ToString()
                $Frame = $Frames.Peek()
                if ($Frame.keys.ContainsKey($Key)) {
                    Fail "$Label contains a duplicate JSON property."
                }
                $Frame.keys[$Key] = $true
            }
            continue
        }
        if ($Character -eq '{') {
            $Frames.Push([PSCustomObject]@{ type = "object"; keys = @{} })
        }
        elseif ($Character -eq '[') {
            $Frames.Push([PSCustomObject]@{ type = "array"; keys = $null })
        }
        elseif ($Character -eq '}') {
            if ($Frames.Count -eq 0 -or $Frames.Peek().type -cne "object") {
                Fail "$Label contains unbalanced JSON containers."
            }
            $Frames.Pop() | Out-Null
        }
        elseif ($Character -eq ']') {
            if ($Frames.Count -eq 0 -or $Frames.Peek().type -cne "array") {
                Fail "$Label contains unbalanced JSON containers."
            }
            $Frames.Pop() | Out-Null
        }
        $Index++
    }
    if ($Frames.Count -ne 0) {
        Fail "$Label contains unbalanced JSON containers."
    }
}

function Read-ControllerJsonStringToken(
    [string]$Text,
    [ref]$Index,
    [string]$Label
) {
    $Position = [int]$Index.Value
    if ($Position -ge $Text.Length -or $Text[$Position] -ne '"') {
        Fail "$Label contains an invalid JSON string token."
    }
    $Builder = New-Object System.Text.StringBuilder
    $Position++
    while ($Position -lt $Text.Length) {
        $Character = $Text[$Position]
        if ($Character -eq '"') {
            $Index.Value = $Position + 1
            return [PSCustomObject]@{ value = $Builder.ToString() }
        }
        if ([int][char]$Character -lt 0x20) {
            Fail "$Label contains an invalid JSON string."
        }
        if ($Character -ne '\') {
            $Builder.Append($Character) | Out-Null
            $Position++
            continue
        }
        $Position++
        if ($Position -ge $Text.Length) {
            Fail "$Label contains an incomplete JSON escape."
        }
        $Escape = $Text[$Position]
        if ($Escape -eq 'u') {
            if ($Position + 4 -ge $Text.Length) {
                Fail "$Label contains an incomplete JSON Unicode escape."
            }
            $Hex = $Text.Substring($Position + 1, 4)
            if ($Hex -notmatch '^[0-9A-Fa-f]{4}$') {
                Fail "$Label contains an invalid JSON Unicode escape."
            }
            $Builder.Append([char][Convert]::ToInt32($Hex, 16)) | Out-Null
            $Position += 5
            continue
        }
        switch ($Escape) {
            '"' { $Decoded = '"' }
            '\' { $Decoded = '\' }
            '/' { $Decoded = '/' }
            'b' { $Decoded = [char]0x0008 }
            'f' { $Decoded = [char]0x000C }
            'n' { $Decoded = [char]0x000A }
            'r' { $Decoded = [char]0x000D }
            't' { $Decoded = [char]0x0009 }
            default { Fail "$Label contains an invalid JSON escape." }
        }
        $Builder.Append($Decoded) | Out-Null
        $Position++
    }
    Fail "$Label contains an unterminated JSON string."
}

function Read-ControllerJsonValue(
    [string]$Text,
    [ref]$Index,
    [System.Collections.Stack]$Frames,
    [string]$Label
) {
    $Position = [int]$Index.Value
    if ($Position -ge $Text.Length) {
        Fail "$Label ends before a JSON value."
    }
    $Character = $Text[$Position]
    if ($Character -eq '{' -or $Character -eq '[') {
        if ($Frames.Count -ge $MaximumControllerJsonNestingDepth) {
            Fail "$Label exceeds the JSON nesting limit."
        }
        if ($Character -eq '{') {
            $Frames.Push([PSCustomObject]@{ type = "object"; state = "key-or-end"; keys = @{} })
        }
        else {
            $Frames.Push([PSCustomObject]@{ type = "array"; state = "value-or-end"; keys = $null })
        }
        $Index.Value = $Position + 1
        return
    }
    if ($Character -eq '"') {
        Read-ControllerJsonStringToken $Text $Index $Label | Out-Null
        return
    }
    foreach ($Literal in @("true", "false", "null")) {
        if ($Position + $Literal.Length -le $Text.Length -and
            $Text.Substring($Position, $Literal.Length) -ceq $Literal) {
            $Index.Value = $Position + $Literal.Length
            return
        }
    }
    if ($Character -eq '-' -or ($Character -ge '0' -and $Character -le '9')) {
        $NumberMatch = $StrictControllerJsonNumberRegex.Match($Text, $Position)
        if ($NumberMatch.Success -and $NumberMatch.Index -eq $Position) {
            $Index.Value = $Position + $NumberMatch.Length
            return
        }
    }
    Fail "$Label contains a value outside the strict JSON grammar."
}

function Assert-StrictJsonGrammar([string]$Text, [string]$Label) {
    $Frames = New-Object System.Collections.Stack
    $Index = 0
    $RootComplete = $false
    while ($true) {
        while ($Index -lt $Text.Length) {
            $CodePoint = [int][char]$Text[$Index]
            if ($CodePoint -ne 0x20 -and $CodePoint -ne 0x09 -and
                $CodePoint -ne 0x0A -and $CodePoint -ne 0x0D) {
                break
            }
            $Index++
        }
        if ($Index -ge $Text.Length) {
            break
        }
        if ($Frames.Count -eq 0) {
            if ($RootComplete -or $Text[$Index] -ne '{') {
                Fail "$Label JSON document must contain one root object."
            }
            $RootComplete = $true
            Read-ControllerJsonValue $Text ([ref]$Index) $Frames $Label
            continue
        }

        $Frame = $Frames.Peek()
        $Character = $Text[$Index]
        if ($Frame.type -ceq "object") {
            if ($Frame.state -ceq "key-or-end" -and $Character -eq '}') {
                $Frames.Pop() | Out-Null
                $Index++
                continue
            }
            if ($Frame.state -ceq "key-or-end" -or $Frame.state -ceq "key") {
                if ($Character -ne '"') {
                    Fail "$Label contains an invalid JSON object property."
                }
                $Token = Read-ControllerJsonStringToken $Text ([ref]$Index) $Label
                $Key = [string]$Token.value
                if ($Frame.keys.ContainsKey($Key)) {
                    Fail "$Label contains a duplicate JSON property."
                }
                $Frame.keys[$Key] = $true
                $Frame.state = "colon"
                continue
            }
            if ($Frame.state -ceq "colon") {
                if ($Character -ne ':') {
                    Fail "$Label contains a JSON property without a colon."
                }
                $Frame.state = "value"
                $Index++
                continue
            }
            if ($Frame.state -ceq "value") {
                $Frame.state = "comma-or-end"
                Read-ControllerJsonValue $Text ([ref]$Index) $Frames $Label
                continue
            }
            if ($Frame.state -ceq "comma-or-end") {
                if ($Character -eq ',') {
                    $Frame.state = "key"
                    $Index++
                    continue
                }
                if ($Character -eq '}') {
                    $Frames.Pop() | Out-Null
                    $Index++
                    continue
                }
                Fail "$Label contains an invalid JSON object separator."
            }
            Fail "$Label contains an invalid JSON object state."
        }

        if ($Frame.type -cne "array") {
            Fail "$Label contains an invalid JSON container."
        }
        if ($Frame.state -ceq "value-or-end" -and $Character -eq ']') {
            $Frames.Pop() | Out-Null
            $Index++
            continue
        }
        if ($Frame.state -ceq "value-or-end" -or $Frame.state -ceq "value") {
            $Frame.state = "comma-or-end"
            Read-ControllerJsonValue $Text ([ref]$Index) $Frames $Label
            continue
        }
        if ($Frame.state -ceq "comma-or-end") {
            if ($Character -eq ',') {
                $Frame.state = "value"
                $Index++
                continue
            }
            if ($Character -eq ']') {
                $Frames.Pop() | Out-Null
                $Index++
                continue
            }
            Fail "$Label contains an invalid JSON array separator."
        }
        Fail "$Label contains an invalid JSON array state."
    }
    if (-not $RootComplete -or $Frames.Count -ne 0) {
        Fail "$Label contains incomplete JSON."
    }
}

function Read-JsonFile([string]$Path, [string]$Label) {
    try {
        $ResolvedJson = Resolve-RealLocalPath $Path $Label "Leaf"
        $JsonItem = Get-Item -LiteralPath $ResolvedJson -Force -ErrorAction Stop
        if ($JsonItem.Length -le 0 -or $JsonItem.Length -gt $MaximumControllerJsonBytes) {
            Fail "$Label is empty or exceeds the JSON size limit."
        }
        $Text = [System.IO.File]::ReadAllText($ResolvedJson, $StrictUtf8)
        $Trimmed = $Text.Trim()
        if (-not $Trimmed.StartsWith("{", [System.StringComparison]::Ordinal) -or
            -not $Trimmed.EndsWith("}", [System.StringComparison]::Ordinal)) {
            Fail "$Label must be one JSON object."
        }
        Assert-StrictJsonGrammar $Text $Label
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Fail "$Label is not strict UTF-8 JSON."
    }
}

function Assert-ExactKeys($Value, [string[]]$Expected, [string]$Label) {
    if ($null -eq $Value) {
        Fail "$Label is missing."
    }
    $Actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $Wanted = @($Expected | Sort-Object)
    if (($Actual -join "`n") -cne ($Wanted -join "`n")) {
        Fail "$Label does not use the closed schema."
    }
}

function Assert-ExactValue($Actual, $Expected, [string]$Label) {
    if ($null -eq $Actual -or
        $null -eq $Expected -or
        $Actual.GetType() -ne $Expected.GetType() -or
        -not $Actual.Equals($Expected)) {
        Fail "$Label does not match the closed contract."
    }
}

function Assert-Sha256Value($Value, [string]$Label) {
    if ($null -eq $Value -or
        $Value.GetType() -ne [string] -or
        [string]$Value -cnotmatch "^sha256:[0-9a-f]{64}$") {
        Fail "$Label is not a canonical SHA-256 value."
    }
}

function Assert-ExactChildNames([string]$Directory, [string[]]$Expected, [string]$Label) {
    $ResolvedDirectory = Resolve-RealLocalPath $Directory $Label "Container"
    $ActualNames = @(
        Get-ChildItem -LiteralPath $ResolvedDirectory -Force |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    $ExpectedNames = @($Expected | Sort-Object)
    if (($ActualNames -join "`n") -cne ($ExpectedNames -join "`n")) {
        Fail "$Label does not contain the closed file set."
    }
}

function Resolve-RealLocalPath(
    [string]$Path,
    [string]$Label,
    [ValidateSet("Container", "Leaf")]
    [string]$Kind
) {
    if ([string]::IsNullOrWhiteSpace($Path) -or
        $Path -cnotmatch "^[A-Za-z]:[\\/]" -or
        $Path.StartsWith("\\?\", [System.StringComparison]::Ordinal) -or
        $Path.StartsWith("\??\", [System.StringComparison]::Ordinal) -or
        $Path.Contains(";")) {
        Fail "$Label must be an absolute local path."
    }
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    if ($FullPath.Length -lt 3 -or $FullPath.Substring(2).Contains(":")) {
        Fail "$Label must not contain an alternate data stream."
    }
    if ($Kind -eq "Container" -and -not (Test-Path -LiteralPath $FullPath -PathType Container)) {
        Fail "$Label directory is unavailable."
    }
    if ($Kind -eq "Leaf" -and -not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        Fail "$Label file is unavailable."
    }
    $Item = Get-Item -LiteralPath $FullPath -Force
    if ($Kind -eq "Container" -and -not $Item.PSIsContainer) {
        Fail "$Label is not a directory."
    }
    if ($Kind -eq "Leaf" -and $Item.PSIsContainer) {
        Fail "$Label is not a regular file."
    }
    $Cursor = $Item
    while ($null -ne $Cursor) {
        if (($Cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail "$Label or one of its ancestors is a reparse point."
        }
        if ($Cursor -is [System.IO.FileInfo]) {
            $Cursor = $Cursor.Directory
        }
        else {
            $Cursor = $Cursor.Parent
        }
    }
    return $Item.FullName
}

function Test-PathContains([string]$Parent, [string]$Child) {
    $ParentPrefix = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
    $ChildPath = [System.IO.Path]::GetFullPath($Child).TrimEnd("\") + "\"
    return $ChildPath.StartsWith($ParentPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256([string]$Path) {
    return "sha256:" + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-RepositorySnapshot([string]$Commit) {
    $Git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $Git) {
        Fail "Git is required on the controller to bind the harness checkout."
    }
    $HeadLines = @(& $Git.Source -C $RepositoryRoot rev-parse --verify HEAD 2>$null)
    $HeadExitCode = $LASTEXITCODE
    if ($HeadExitCode -ne 0 -or $HeadLines.Count -ne 1 -or [string]$HeadLines[0] -cne $Commit) {
        Fail "the harness checkout is not at the requested release commit."
    }
    $StatusLines = @(& $Git.Source -C $RepositoryRoot status --porcelain=v1 --untracked-files=all 2>$null)
    $StatusExitCode = $LASTEXITCODE
    if ($StatusExitCode -ne 0 -or $StatusLines.Count -ne 0) {
        Fail "the harness checkout must be clean before preparing evidence."
    }
    foreach ($RelativePath in @(
        "scripts/invoke-clean-host-acceptance.ps1",
        "scripts/extract-verified-artifact.py",
        "scripts/ue-release-variants.json"
    )) {
        $ExpectedLines = @(& $Git.Source -C $RepositoryRoot rev-parse --verify "$Commit`:$RelativePath" 2>$null)
        $ExpectedExitCode = $LASTEXITCODE
        $ActualLines = @(& $Git.Source -C $RepositoryRoot hash-object "--path=$RelativePath" -- $RelativePath 2>$null)
        $ActualExitCode = $LASTEXITCODE
        if ($ExpectedExitCode -ne 0 -or
            $ActualExitCode -ne 0 -or
            $ExpectedLines.Count -ne 1 -or
            $ActualLines.Count -ne 1 -or
            [string]$ExpectedLines[0] -cne [string]$ActualLines[0]) {
            Fail "a controller bootstrap file does not match the release commit."
        }
    }
    return [string]$Git.Source
}

function Write-CanonicalJson([string]$Path, $Value) {
    $Json = $Value | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $Json + "`n", $StrictUtf8)
}

function Write-Utf8FileNoOverwrite([string]$Path, [string]$Value, [string]$Label) {
    $Stream = $null
    $Writer = $null
    try {
        $Stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None)
        $Writer = [System.IO.StreamWriter]::new($Stream, $StrictUtf8)
        $Stream = $null
        $Writer.Write($Value)
        $Writer.Flush()
    }
    catch [System.IO.IOException] {
        Fail "$Label must be fresh and must not already exist."
    }
    finally {
        if ($null -ne $Writer) {
            $Writer.Dispose()
        }
        if ($null -ne $Stream) {
            $Stream.Dispose()
        }
    }
}

function Get-VariantRegistry {
    $RegistryPath = Resolve-RealLocalPath $VariantRegistryPath "variant registry" "Leaf"
    $Registry = Read-JsonFile $RegistryPath "variant registry"
    Assert-ExactKeys $Registry @("schemaVersion", "variants") "variant registry"
    if ($Registry.schemaVersion -ne 1 -or @($Registry.variants).Count -ne 3) {
        Fail "variant registry does not contain the closed three-variant set."
    }
    $Ids = @($Registry.variants | ForEach-Object { [string]$_.id })
    if (($Ids -join ",") -cne "ue54,ue55,ue58") {
        Fail "variant registry order is not closed."
    }
    return @($Registry.variants)
}

function Assert-EngineIdentity($Variant, [string]$EngineRoot) {
    $Root = Resolve-RealLocalPath $EngineRoot "$($Variant.id) engine root" "Container"
    $Paths = [ordered]@{
        build = Join-Path $Root "Engine/Build/Build.version"
        editor = Join-Path $Root "Engine/Binaries/Win64/UnrealEditor.version"
        modules = Join-Path $Root "Engine/Binaries/Win64/UnrealEditor.modules"
        editorCmd = Join-Path $Root "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
        python = Join-Path $Root "Engine/Binaries/ThirdParty/Python3/Win64/python.exe"
    }
    foreach ($Name in @($Paths.Keys)) {
        $Paths[$Name] = Resolve-RealLocalPath $Paths[$Name] "$($Variant.id) $Name" "Leaf"
    }
    $Build = Read-JsonFile $Paths.build "$($Variant.id) Build.version"
    $Editor = Read-JsonFile $Paths.editor "$($Variant.id) UnrealEditor.version"
    $Modules = Read-JsonFile $Paths.modules "$($Variant.id) UnrealEditor.modules"
    foreach ($Identity in @($Build, $Editor)) {
        foreach ($Pair in @(
            @("MajorVersion", [int]$Variant.engine.majorVersion),
            @("MinorVersion", [int]$Variant.engine.minorVersion),
            @("PatchVersion", [int]$Variant.engine.patchVersion),
            @("Changelist", [int]$Variant.engine.changelist),
            @("CompatibleChangelist", [int]$Variant.engine.compatibleChangelist),
            @("BranchName", [string]$Variant.engine.branchName)
        )) {
            $Name = [string]$Pair[0]
            if ($Identity.$Name -cne $Pair[1]) {
                Fail "$($Variant.id) engine identity does not match the registry."
            }
        }
    }
    if ([string]$Editor.BuildId -cne [string]$Variant.engine.buildId -or
        [string]$Modules.BuildId -cne [string]$Variant.engine.buildId) {
        Fail "$($Variant.id) engine BuildId does not match the registry."
    }
    return [PSCustomObject]@{
        root = $Root
        embeddedPython = $Paths.python
    }
}

function Find-Provenance([string]$Root) {
    $Candidates = @(
        @(
            (Join-Path $Root "metadata/provenance.json"),
            (Join-Path $Root "provenance.json")
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    )
    if ($Candidates.Count -ne 1) {
        Fail "candidate root must contain exactly one provenance.json at a supported location."
    }
    return Resolve-RealLocalPath $Candidates[0] "release provenance" "Leaf"
}

function Read-CoreInputs([string]$Root, [string]$Commit, $Variants) {
    $Provenance = Read-JsonFile (Find-Provenance $Root) "release provenance"
    if ($Provenance.schemaVersion -ne 3 -or
        [string]$Provenance.repository -cne $RepositoryName -or
        [string]$Provenance.releaseTag -cne $ReleaseTag -or
        [string]$Provenance.releaseCommit -cne $Commit -or
        @($Provenance.ueValidation.variants).Count -ne 3) {
        Fail "release provenance is not bound to the requested tag and commit."
    }
    $Records = @()
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $Variant = $Variants[$Index]
        $FileName = "UnrealEditorWebUI-$ReleaseTag-$($Variant.releaseVariant).zip"
        $Archive = Resolve-RealLocalPath (Join-Path $Root $FileName) "$($Variant.id) archive" "Leaf"
        $Sidecar = Resolve-RealLocalPath "$Archive.sha256" "$($Variant.id) sidecar" "Leaf"
        $ArchiveItem = Get-Item -LiteralPath $Archive -Force -ErrorAction Stop
        $SidecarItem = Get-Item -LiteralPath $Sidecar -Force -ErrorAction Stop
        if ($ArchiveItem.Length -le 0 -or $ArchiveItem.Length -gt $MaximumCoreArchiveBytes) {
            Fail "$($Variant.id) archive is empty or exceeds the package profile size limit."
        }
        if ($SidecarItem.Length -le 0 -or $SidecarItem.Length -gt $MaximumChecksumSidecarBytes) {
            Fail "$($Variant.id) sidecar is empty or exceeds its size limit."
        }
        $Digest = Get-Sha256 $Archive
        $SidecarText = [System.IO.File]::ReadAllText($Sidecar, $StrictUtf8).TrimEnd("`r", "`n")
        if ($SidecarText -cne "$($Digest.Substring(7))  $FileName") {
            Fail "$($Variant.id) sidecar does not match the archive."
        }
        $ProvenanceVariant = @($Provenance.ueValidation.variants)[$Index]
        if ([string]$ProvenanceVariant.releaseVariant -cne [string]$Variant.releaseVariant -or
            [string]$ProvenanceVariant.releaseArchive.fileName -cne $FileName -or
            [string]$ProvenanceVariant.releaseArchive.sha256 -cne $Digest) {
            Fail "$($Variant.id) provenance archive binding is invalid."
        }
        $Records += [PSCustomObject]@{
            variantId = [string]$Variant.id
            subject = $FileName
            sourcePath = $Archive
            sha256 = $Digest
            expectedEngineVersion = "$($Variant.engineAssociation).0"
            expectedBuildId = [string]$Variant.engine.buildId
        }
    }
    return $Records
}

function New-RepositorySourceSnapshot(
    [string]$GitPath,
    [string]$Commit,
    [string]$ArchivePath,
    [string]$Destination,
    [string]$EmbeddedPython,
    [string]$Extractor
) {
    if ((Test-Path -LiteralPath $ArchivePath) -or (Test-Path -LiteralPath $Destination)) {
        Fail "repository source snapshot destinations must be fresh."
    }
    $SnapshotPaths = @(
        "examples/tool-packs/ExampleAssetTools",
        "Python/unreal_editor_webui_toolpack_integrity.py",
        "Python/unreal_editor_webui_toolpacks.py",
        "scripts/extract-verified-artifact.py",
        "scripts/invoke-clean-host-acceptance.ps1",
        "scripts/package-tool-pack.py",
        "scripts/run-clean-host-acceptance-guest.ps1",
        "scripts/tool_pack_distribution.py",
        "scripts/ue-release-variants.json",
        "scripts/ue-release-variants.mjs",
        "scripts/validate-clean-host-evidence.mjs",
        "tests/fixtures/ue-tool-packs/AssetToolsFixture",
        "tests/fixtures/ue-tool-packs/LevelToolsFixture"
    )
    $PreviousPreference = $ErrorActionPreference
    $ArchiveExitCode = -1
    try {
        $ErrorActionPreference = "Continue"
        & $GitPath -C $RepositoryRoot archive --format=zip "--output=$ArchivePath" $Commit -- @SnapshotPaths 2>&1 | Out-Null
        $ArchiveExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ArchiveExitCode -ne 0) {
        Fail "the exact-commit repository source snapshot could not be created."
    }
    $ResolvedArchive = Resolve-RealLocalPath $ArchivePath "repository source snapshot" "Leaf"
    $ExtractionExitCode = -1
    try {
        $ErrorActionPreference = "Continue"
        & $EmbeddedPython $Extractor --archive $ResolvedArchive --destination $Destination --profile package 2>&1 | Out-Null
        $ExtractionExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExtractionExitCode -ne 0 -or -not (Test-Path -LiteralPath $Destination -PathType Container)) {
        Fail "the exact-commit repository source snapshot could not be extracted safely."
    }
    return Get-Sha256 $ResolvedArchive
}

function New-WsbConfiguration(
    [string]$Path,
    [string]$InputRoot,
    [string]$EngineRoot,
    [string]$EvidenceRoot,
    [string]$VariantId,
    [int]$MemoryMB
) {
    $Settings = New-Object System.Xml.XmlWriterSettings
    $Settings.Indent = $true
    $Settings.Encoding = $StrictUtf8
    $Writer = [System.Xml.XmlWriter]::Create($Path, $Settings)
    try {
        $Writer.WriteStartDocument()
        $Writer.WriteStartElement("Configuration")
        foreach ($Entry in @(
            @("VGpu", "Disable"),
            @("Networking", "Disable"),
            @("AudioInput", "Disable"),
            @("VideoInput", "Disable"),
            @("PrinterRedirection", "Disable"),
            @("ClipboardRedirection", "Disable"),
            @("ProtectedClient", "Enable"),
            @("MemoryInMB", [string]$MemoryMB)
        )) {
            $Writer.WriteElementString([string]$Entry[0], [string]$Entry[1])
        }
        $Writer.WriteStartElement("MappedFolders")
        foreach ($Mapping in @(
            @($InputRoot, "C:\UEWebUI\Input", "true"),
            @($EngineRoot, "C:\UEWebUI\Engine", "true"),
            @($EvidenceRoot, "C:\UEWebUI\Evidence", "false")
        )) {
            $Writer.WriteStartElement("MappedFolder")
            $Writer.WriteElementString("HostFolder", [string]$Mapping[0])
            $Writer.WriteElementString("SandboxFolder", [string]$Mapping[1])
            $Writer.WriteElementString("ReadOnly", [string]$Mapping[2])
            $Writer.WriteEndElement()
        }
        $Writer.WriteEndElement()
        $Writer.WriteStartElement("LogonCommand")
        $Writer.WriteElementString(
            "Command",
            "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\UEWebUI\Input\harness\run-clean-host-acceptance-guest.ps1 -Plan C:\UEWebUI\Input\plans\$VariantId.json -EvidenceRoot C:\UEWebUI\Evidence")
        $Writer.WriteEndElement()
        $Writer.WriteEndElement()
        $Writer.WriteEndDocument()
    }
    finally {
        $Writer.Dispose()
    }
}

function Assert-ManifestFileRecord(
    $Record,
    [string]$ExpectedSubject,
    [string]$Path,
    [string]$Label
) {
    Assert-ExactKeys $Record @("subject", "sha256") $Label
    Assert-ExactValue $Record.subject $ExpectedSubject "$Label.subject"
    Assert-Sha256Value $Record.sha256 "$Label.sha256"
    $ResolvedPath = Resolve-RealLocalPath $Path $Label "Leaf"
    if ((Get-Sha256 $ResolvedPath) -cne [string]$Record.sha256) {
        Fail "$Label hash does not match the run manifest."
    }
    return $ResolvedPath
}

function Assert-HarnessRecord(
    $Record,
    [string]$ExpectedSubject,
    [string]$ExpectedRelativePath,
    [string]$Path,
    [string]$Label
) {
    Assert-ExactKeys $Record @("subject", "relativePath", "sha256") $Label
    Assert-ExactValue $Record.subject $ExpectedSubject "$Label.subject"
    Assert-ExactValue $Record.relativePath $ExpectedRelativePath "$Label.relativePath"
    Assert-Sha256Value $Record.sha256 "$Label.sha256"
    $ResolvedPath = Resolve-RealLocalPath $Path $Label "Leaf"
    if ((Get-Sha256 $ResolvedPath) -cne [string]$Record.sha256) {
        Fail "$Label hash does not match the run manifest."
    }
    return $ResolvedPath
}

function Assert-PlanDocument(
    $Plan,
    $Manifest,
    $Variant,
    [string]$InputRoot,
    [string]$Label
) {
    Assert-ExactKeys $Plan @(
        "schemaVersion", "runId", "sourceKind", "release", "target", "harness",
        "coreArchives", "toolPacks"
    ) $Label
    Assert-ExactValue $Plan.schemaVersion 1 "$Label.schemaVersion"
    Assert-ExactValue $Plan.runId $Manifest.runId "$Label.runId"
    Assert-ExactValue $Plan.sourceKind $Manifest.release.sourceKind "$Label.sourceKind"
    Assert-ExactKeys $Plan.release @("tag", "commit") "$Label.release"
    Assert-ExactValue $Plan.release.tag $Manifest.release.tag "$Label.release.tag"
    Assert-ExactValue $Plan.release.commit $Manifest.release.commit "$Label.release.commit"

    Assert-ExactKeys $Plan.harness @("guestScript", "extractor") "$Label.harness"
    foreach ($HarnessName in @("guestScript", "extractor")) {
        $Expected = $Manifest.harness.$HarnessName
        $Actual = $Plan.harness.$HarnessName
        Assert-ExactKeys $Actual @("subject", "relativePath", "sha256") "$Label.harness.$HarnessName"
        foreach ($Name in @("subject", "relativePath", "sha256")) {
            Assert-ExactValue $Actual.$Name $Expected.$Name "$Label.harness.$HarnessName.$Name"
        }
    }

    Assert-ExactKeys $Plan.target @(
        "variantId", "releaseVariant", "engineAssociation", "engine"
    ) "$Label.target"
    Assert-ExactValue $Plan.target.variantId $Variant.id "$Label.target.variantId"
    Assert-ExactValue $Plan.target.releaseVariant $Variant.releaseVariant "$Label.target.releaseVariant"
    Assert-ExactValue $Plan.target.engineAssociation $Variant.engineAssociation "$Label.target.engineAssociation"
    Assert-ExactKeys $Plan.target.engine @(
        "majorVersion", "minorVersion", "patchVersion", "changelist",
        "compatibleChangelist", "branchName", "buildId"
    ) "$Label.target.engine"
    foreach ($Name in @(
        "majorVersion", "minorVersion", "patchVersion", "changelist",
        "compatibleChangelist", "branchName", "buildId"
    )) {
        Assert-ExactValue $Plan.target.engine.$Name $Variant.engine.$Name "$Label.target.engine.$Name"
    }

    $Variants = @(Get-VariantRegistry)
    $CorePlans = @($Plan.coreArchives)
    if ($CorePlans.Count -ne 3) {
        Fail "$Label.coreArchives does not contain the closed set."
    }
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $ExpectedVariant = $Variants[$Index]
        $Core = $CorePlans[$Index]
        Assert-ExactKeys $Core @(
            "variantId", "subject", "relativePath", "sha256",
            "expectedEngineVersion", "expectedBuildId"
        ) "$Label.coreArchives[$Index]"
        $ExpectedSubject = "UnrealEditorWebUI-$ReleaseTag-$($ExpectedVariant.releaseVariant).zip"
        Assert-ExactValue $Core.variantId $ExpectedVariant.id "$Label.coreArchives[$Index].variantId"
        Assert-ExactValue $Core.subject $ExpectedSubject "$Label.coreArchives[$Index].subject"
        Assert-ExactValue $Core.relativePath "core/$ExpectedSubject" "$Label.coreArchives[$Index].relativePath"
        Assert-Sha256Value $Core.sha256 "$Label.coreArchives[$Index].sha256"
        Assert-ExactValue $Core.expectedEngineVersion "$($ExpectedVariant.engineAssociation).0" "$Label.coreArchives[$Index].expectedEngineVersion"
        Assert-ExactValue $Core.expectedBuildId $ExpectedVariant.engine.buildId "$Label.coreArchives[$Index].expectedBuildId"
        $Archive = Resolve-RealLocalPath (Join-Path $InputRoot "core\$ExpectedSubject") "$Label core archive" "Leaf"
        if ((Get-Sha256 $Archive) -cne [string]$Core.sha256) {
            Fail "$Label core archive hash does not match its plan."
        }
    }

    $ToolPackDefinitions = @(
        [PSCustomObject]@{ id = "AssetToolsFixture"; subject = "AssetToolsFixture-1.0.0-ToolPack.zip" },
        [PSCustomObject]@{ id = "LevelToolsFixture"; subject = "LevelToolsFixture-1.0.0-ToolPack.zip" },
        [PSCustomObject]@{ id = "ExampleAssetTools"; subject = "ExampleAssetTools-1.0.0-ToolPack.zip" }
    )
    $ToolPacks = @($Plan.toolPacks)
    if ($ToolPacks.Count -ne 3) {
        Fail "$Label.toolPacks does not contain the closed set."
    }
    for ($Index = 0; $Index -lt $ToolPackDefinitions.Count; $Index++) {
        $Expected = $ToolPackDefinitions[$Index]
        $ToolPack = $ToolPacks[$Index]
        Assert-ExactKeys $ToolPack @("id", "subject", "relativePath", "sha256") "$Label.toolPacks[$Index]"
        Assert-ExactValue $ToolPack.id $Expected.id "$Label.toolPacks[$Index].id"
        Assert-ExactValue $ToolPack.subject $Expected.subject "$Label.toolPacks[$Index].subject"
        Assert-ExactValue $ToolPack.relativePath "tool-packs/$($Expected.subject)" "$Label.toolPacks[$Index].relativePath"
        Assert-Sha256Value $ToolPack.sha256 "$Label.toolPacks[$Index].sha256"
        $Archive = Resolve-RealLocalPath (Join-Path $InputRoot "tool-packs\$($Expected.subject)") "$Label Tool Pack archive" "Leaf"
        if ((Get-Sha256 $Archive) -cne [string]$ToolPack.sha256) {
            Fail "$Label Tool Pack hash does not match its plan."
        }
    }
}

function Get-ValidatedRunContext([string]$Root) {
    $ResolvedRunRoot = Resolve-RealLocalPath $Root "run root" "Container"
    $PrivateRoot = Join-Path $ResolvedRunRoot "private"
    $PublicRoot = Join-Path $ResolvedRunRoot "public"
    Assert-ExactChildNames $ResolvedRunRoot @("private", "public") "run root"
    Assert-ExactChildNames $PrivateRoot @(
        "controller", "evidence", "input", "run-manifest.json", "source-snapshot",
        "source-snapshot.zip", "tool-pack-build", "wsb"
    ) "private run root"
    Assert-ExactChildNames $PublicRoot @() "public run root"

    $Manifest = Read-JsonFile (Join-Path $PrivateRoot "run-manifest.json") "private run manifest"
    Assert-ExactKeys $Manifest @(
        "schemaVersion", "runId", "runRootName", "release", "sourceSnapshot",
        "controller", "harness", "plans", "configurations"
    ) "private run manifest"
    Assert-ExactValue $Manifest.schemaVersion 1 "private run manifest.schemaVersion"
    if ($null -eq $Manifest.runId -or
        $Manifest.runId.GetType() -ne [string] -or
        [string]$Manifest.runId -cnotmatch "^[0-9a-f]{32}$") {
        Fail "private run manifest.runId is invalid."
    }
    $ExpectedRunRootName = "uewebui-clean-$($Manifest.runId)"
    Assert-ExactValue $Manifest.runRootName $ExpectedRunRootName "private run manifest.runRootName"
    $ActualRunRootName = [System.IO.Path]::GetFileName($ResolvedRunRoot.TrimEnd("\"))
    if ($ActualRunRootName -cne $ExpectedRunRootName) {
        Fail "the run root name is not bound to the private run manifest."
    }

    Assert-ExactKeys $Manifest.release @("tag", "commit", "sourceKind") "private run manifest.release"
    Assert-ExactValue $Manifest.release.tag $ReleaseTag "private run manifest.release.tag"
    if ($null -eq $Manifest.release.commit -or
        $Manifest.release.commit.GetType() -ne [string] -or
        [string]$Manifest.release.commit -cnotmatch "^[0-9a-f]{40}$") {
        Fail "private run manifest.release.commit is invalid."
    }
    if ($null -eq $Manifest.release.sourceKind -or
        $Manifest.release.sourceKind.GetType() -ne [string] -or
        ([string]$Manifest.release.sourceKind -cne "candidate" -and
         [string]$Manifest.release.sourceKind -cne "published")) {
        Fail "private run manifest.release.sourceKind is invalid."
    }
    Assert-RepositorySnapshot ([string]$Manifest.release.commit) | Out-Null

    $ControllerRoot = Join-Path $PrivateRoot "controller"
    $InputRoot = Join-Path $PrivateRoot "input"
    $HarnessRoot = Join-Path $InputRoot "harness"
    $PlansRoot = Join-Path $InputRoot "plans"
    $WsbRoot = Join-Path $PrivateRoot "wsb"
    $EvidenceRoot = Join-Path $PrivateRoot "evidence"
    Assert-ExactChildNames $ControllerRoot @(
        "invoke-clean-host-acceptance.ps1", "ue-release-variants.json",
        "ue-release-variants.mjs", "validate-clean-host-evidence.mjs"
    ) "controller snapshot"
    Assert-ExactChildNames $InputRoot @("core", "harness", "plans", "tool-packs") "mapped input"
    Assert-ExactChildNames $HarnessRoot @(
        "extract-verified-artifact.py", "run-clean-host-acceptance-guest.ps1"
    ) "mapped harness"
    Assert-ExactChildNames (Join-Path $InputRoot "core") @(
        "UnrealEditorWebUI-v0.3.0-UE54-Win64.zip",
        "UnrealEditorWebUI-v0.3.0-UE55-Win64.zip",
        "UnrealEditorWebUI-v0.3.0-UE58-Win64.zip"
    ) "mapped core archives"
    Assert-ExactChildNames (Join-Path $InputRoot "tool-packs") @(
        "AssetToolsFixture-1.0.0-ToolPack.zip",
        "LevelToolsFixture-1.0.0-ToolPack.zip",
        "ExampleAssetTools-1.0.0-ToolPack.zip"
    ) "mapped Tool Packs"
    Assert-ExactChildNames $PlansRoot @("ue54.json", "ue55.json", "ue58.json") "mapped plans"
    Assert-ExactChildNames $WsbRoot @("ue54.wsb", "ue55.wsb", "ue58.wsb") "Sandbox configurations"
    Assert-ExactChildNames $EvidenceRoot @("ue54", "ue55", "ue58") "private evidence"
    Assert-ExactChildNames (Join-Path $PrivateRoot "tool-pack-build") @(
        "AssetToolsFixture", "ExampleAssetTools", "LevelToolsFixture"
    ) "Tool Pack build staging"
    Assert-ExactChildNames (Join-Path $PrivateRoot "source-snapshot") @(
        "examples", "Python", "scripts", "tests"
    ) "repository source snapshot"

    Assert-ExactKeys $Manifest.sourceSnapshot @("subject", "sha256") "private run manifest.sourceSnapshot"
    Assert-ManifestFileRecord `
        $Manifest.sourceSnapshot `
        "source-snapshot.zip" `
        (Join-Path $PrivateRoot "source-snapshot.zip") `
        "repository source snapshot archive" | Out-Null

    Assert-ExactKeys $Manifest.controller @(
        "hostScript", "validator", "variantRegistry", "variantModule"
    ) "private run manifest.controller"
    Assert-ManifestFileRecord `
        $Manifest.controller.hostScript `
        "invoke-clean-host-acceptance.ps1" `
        (Join-Path $ControllerRoot "invoke-clean-host-acceptance.ps1") `
        "controller host script" | Out-Null
    $Validator = Assert-ManifestFileRecord `
        $Manifest.controller.validator `
        "validate-clean-host-evidence.mjs" `
        (Join-Path $ControllerRoot "validate-clean-host-evidence.mjs") `
        "controller evidence validator"
    Assert-ManifestFileRecord `
        $Manifest.controller.variantRegistry `
        "ue-release-variants.json" `
        (Join-Path $ControllerRoot "ue-release-variants.json") `
        "controller variant registry" | Out-Null
    Assert-ManifestFileRecord `
        $Manifest.controller.variantModule `
        "ue-release-variants.mjs" `
        (Join-Path $ControllerRoot "ue-release-variants.mjs") `
        "controller variant module" | Out-Null
    Resolve-RealLocalPath $PSCommandPath "running controller host script" "Leaf" | Out-Null

    Assert-ExactKeys $Manifest.harness @("guestScript", "extractor") "private run manifest.harness"
    $GuestScript = Assert-HarnessRecord `
        $Manifest.harness.guestScript `
        "run-clean-host-acceptance-guest.ps1" `
        "harness/run-clean-host-acceptance-guest.ps1" `
        (Join-Path $HarnessRoot "run-clean-host-acceptance-guest.ps1") `
        "mapped guest script"
    $Extractor = Assert-HarnessRecord `
        $Manifest.harness.extractor `
        "extract-verified-artifact.py" `
        "harness/extract-verified-artifact.py" `
        (Join-Path $HarnessRoot "extract-verified-artifact.py") `
        "mapped safe extractor"

    $Variants = @(Get-VariantRegistry)
    $PlanRecords = @($Manifest.plans)
    $ConfigurationRecords = @($Manifest.configurations)
    if ($PlanRecords.Count -ne 3 -or $ConfigurationRecords.Count -ne 3) {
        Fail "the run manifest does not contain the closed three-variant file set."
    }
    $PlanDocuments = [ordered]@{}
    $PlanHashes = [ordered]@{}
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $Variant = $Variants[$Index]
        $VariantId = [string]$Variant.id
        $PlanRecord = $PlanRecords[$Index]
        Assert-ExactKeys $PlanRecord @("variantId", "subject", "sha256") "private run manifest.plans[$Index]"
        Assert-ExactValue $PlanRecord.variantId $Variant.id "private run manifest.plans[$Index].variantId"
        $PlanPath = Assert-ManifestFileRecord `
            ([PSCustomObject]@{ subject = $PlanRecord.subject; sha256 = $PlanRecord.sha256 }) `
            "$VariantId.json" `
            (Join-Path $PlansRoot "$VariantId.json") `
            "$VariantId plan"
        $Plan = Read-JsonFile $PlanPath "$VariantId plan"
        Assert-PlanDocument $Plan $Manifest $Variant $InputRoot "$VariantId plan"
        $PlanDocuments[$VariantId] = $Plan
        $PlanHashes[$VariantId] = [string]$PlanRecord.sha256

        $ConfigurationRecord = $ConfigurationRecords[$Index]
        Assert-ExactKeys $ConfigurationRecord @("variantId", "subject", "sha256") "private run manifest.configurations[$Index]"
        Assert-ExactValue $ConfigurationRecord.variantId $Variant.id "private run manifest.configurations[$Index].variantId"
        Assert-ManifestFileRecord `
            ([PSCustomObject]@{ subject = $ConfigurationRecord.subject; sha256 = $ConfigurationRecord.sha256 }) `
            "$VariantId.wsb" `
            (Join-Path $WsbRoot "$VariantId.wsb") `
            "$VariantId Sandbox configuration" | Out-Null
    }

    $ResultPaths = [ordered]@{}
    foreach ($Variant in $Variants) {
        $VariantId = [string]$Variant.id
        $VariantEvidence = Join-Path $EvidenceRoot $VariantId
        Assert-ExactChildNames $VariantEvidence @("guest-binding.json", "guest-result.json") "$VariantId evidence"
        $Binding = Read-JsonFile (Join-Path $VariantEvidence "guest-binding.json") "$VariantId guest binding"
        Assert-ExactKeys $Binding @(
            "schemaVersion", "runId", "variantId", "planSha256", "resultSha256",
            "guestScriptSha256", "extractorSha256"
        ) "$VariantId guest binding"
        Assert-ExactValue $Binding.schemaVersion 1 "$VariantId guest binding.schemaVersion"
        Assert-ExactValue $Binding.runId $Manifest.runId "$VariantId guest binding.runId"
        Assert-ExactValue $Binding.variantId $Variant.id "$VariantId guest binding.variantId"
        Assert-ExactValue $Binding.planSha256 $PlanHashes[$VariantId] "$VariantId guest binding.planSha256"
        Assert-ExactValue $Binding.guestScriptSha256 $Manifest.harness.guestScript.sha256 "$VariantId guest binding.guestScriptSha256"
        Assert-ExactValue $Binding.extractorSha256 $Manifest.harness.extractor.sha256 "$VariantId guest binding.extractorSha256"
        Assert-Sha256Value $Binding.resultSha256 "$VariantId guest binding.resultSha256"

        $ResultPath = Resolve-RealLocalPath (Join-Path $VariantEvidence "guest-result.json") "$VariantId guest result" "Leaf"
        if ((Get-Sha256 $ResultPath) -cne [string]$Binding.resultSha256) {
            Fail "$VariantId guest result does not match its completion binding."
        }
        $Result = Read-JsonFile $ResultPath "$VariantId guest result"
        Assert-ExactKeys $Result.release @("tag", "commit", "sourceKind") "$VariantId guest result.release"
        Assert-ExactValue $Result.release.tag $Manifest.release.tag "$VariantId guest result.release.tag"
        Assert-ExactValue $Result.release.commit $Manifest.release.commit "$VariantId guest result.release.commit"
        Assert-ExactValue $Result.release.sourceKind $Manifest.release.sourceKind "$VariantId guest result.release.sourceKind"
        Assert-ExactValue $Result.guest.engine.variantId $Variant.id "$VariantId guest result.guest.engine.variantId"
        Assert-ExactKeys $Result.inputs @("coreArchives", "toolPacks") "$VariantId guest result.inputs"
        $Plan = $PlanDocuments[$VariantId]
        $ResultCores = @($Result.inputs.coreArchives)
        $ResultPacks = @($Result.inputs.toolPacks)
        if ($ResultCores.Count -ne 3 -or $ResultPacks.Count -ne 3) {
            Fail "$VariantId guest result does not contain the closed input set."
        }
        for ($Index = 0; $Index -lt 3; $Index++) {
            Assert-ExactValue $ResultCores[$Index].variantId $Plan.coreArchives[$Index].variantId "$VariantId guest result core variant"
            Assert-ExactValue $ResultCores[$Index].subject $Plan.coreArchives[$Index].subject "$VariantId guest result core subject"
            Assert-ExactValue $ResultCores[$Index].sha256 $Plan.coreArchives[$Index].sha256 "$VariantId guest result core hash"
            Assert-ExactValue $ResultPacks[$Index].id $Plan.toolPacks[$Index].id "$VariantId guest result Tool Pack id"
            Assert-ExactValue $ResultPacks[$Index].subject $Plan.toolPacks[$Index].subject "$VariantId guest result Tool Pack subject"
            Assert-ExactValue $ResultPacks[$Index].sha256 $Plan.toolPacks[$Index].sha256 "$VariantId guest result Tool Pack hash"
        }
        $ResultPaths[$VariantId] = $ResultPath
    }

    return [PSCustomObject]@{
        runRoot = $ResolvedRunRoot
        publicRoot = $PublicRoot
        validator = $Validator
        results = $ResultPaths
    }
}

function Invoke-Finalize([string]$Root) {
    $Context = Get-ValidatedRunContext $Root
    $ResolvedRunRoot = [string]$Context.runRoot
    $PublicRoot = [string]$Context.publicRoot
    $Output = Join-Path $PublicRoot "clean-host-acceptance.json"
    $Sidecar = "$Output.sha256"
    if ((Test-Path -LiteralPath $Output) -or (Test-Path -LiteralPath $Sidecar)) {
        Fail "public clean-host evidence already exists."
    }
    $Node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $Node) {
        Fail "Node.js is required on the controller to validate and aggregate evidence."
    }
    $Validator = [string]$Context.validator
    $Arguments = @(
        $Validator,
        "--ue54", [string]$Context.results.ue54,
        "--ue55", [string]$Context.results.ue55,
        "--ue58", [string]$Context.results.ue58,
        "--output", $Output
    )
    & $Node.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "clean-host evidence aggregation failed."
    }
    $Digest = Get-Sha256 $Output
    Write-Utf8FileNoOverwrite -Path $Sidecar -Value "$($Digest.Substring(7))  clean-host-acceptance.json`n" -Label "public clean-host evidence sidecar"
    return [ordered]@{
        schemaVersion = 1
        result = "finalized"
        evidence = $Output
        sha256 = $Digest
    }
}

if ($Finalize) {
    $FinalizeForbiddenParameters = @(
        "CandidateRoot",
        "SourceKind",
        "ReleaseCommit",
        "UE54Root",
        "UE55Root",
        "UE58Root",
        "OutputParent",
        "SandboxMemoryMB",
        "Launch"
    )
    if (@($FinalizeForbiddenParameters | Where-Object { $PSBoundParameters.ContainsKey($_) }).Count -ne 0) {
        Fail "-Finalize accepts only -RunRoot and controller runtime options."
    }
    if ([string]::IsNullOrWhiteSpace($RunRoot)) {
        Fail "-Finalize requires -RunRoot."
    }
    Write-Output ((Invoke-Finalize $RunRoot) | ConvertTo-Json -Compress)
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($RunRoot)) {
    Fail "-RunRoot is only valid with -Finalize."
}

foreach ($Required in @(
    @("CandidateRoot", $CandidateRoot),
    @("ReleaseCommit", $ReleaseCommit),
    @("OutputParent", $OutputParent)
)) {
    if ([string]::IsNullOrWhiteSpace([string]$Required[1])) {
        Fail "$($Required[0]) is required."
    }
}
if ($ReleaseCommit -cnotmatch "^[0-9a-f]{40}$") {
    Fail "ReleaseCommit must be a lowercase 40-character commit SHA."
}

$ControllerGit = Assert-RepositorySnapshot $ReleaseCommit
$Candidate = Resolve-RealLocalPath $CandidateRoot "candidate root" "Container"
$OutputParentPath = Resolve-RealLocalPath $OutputParent "output parent" "Container"
$ResolvedGuestScript = Resolve-RealLocalPath $GuestScriptPath "guest script" "Leaf"
$ResolvedExtractor = Resolve-RealLocalPath $ExtractorPath "safe extractor" "Leaf"
$Variants = @(Get-VariantRegistry)
$EngineRoots = [ordered]@{ ue54 = $UE54Root; ue55 = $UE55Root; ue58 = $UE58Root }
$Engines = [ordered]@{}
foreach ($Variant in $Variants) {
    $Engines[[string]$Variant.id] = Assert-EngineIdentity $Variant $EngineRoots[[string]$Variant.id]
}
foreach ($ProtectedRoot in @($Candidate, $RepositoryRoot) + @($Engines.Values | ForEach-Object { $_.root })) {
    if ((Test-PathContains $ProtectedRoot $OutputParentPath) -or
        (Test-PathContains $OutputParentPath $ProtectedRoot)) {
        Fail "output parent must be separate from candidate, repository, and engine roots."
    }
}

$CoreInputs = @(Read-CoreInputs $Candidate $ReleaseCommit $Variants)
$RunId = [guid]::NewGuid().ToString("N")
$NewRunRoot = Join-Path $OutputParentPath "uewebui-clean-$RunId"
if (Test-Path -LiteralPath $NewRunRoot) {
    Fail "generated run root is not fresh."
}
$PrivateRoot = Join-Path $NewRunRoot "private"
$InputRoot = Join-Path $PrivateRoot "input"
$CoreRoot = Join-Path $InputRoot "core"
$ToolPackRoot = Join-Path $InputRoot "tool-packs"
$HarnessRoot = Join-Path $InputRoot "harness"
$PlansRoot = Join-Path $InputRoot "plans"
$WsbRoot = Join-Path $PrivateRoot "wsb"
$EvidenceParent = Join-Path $PrivateRoot "evidence"
$ControllerRoot = Join-Path $PrivateRoot "controller"
$SourceSnapshotArchive = Join-Path $PrivateRoot "source-snapshot.zip"
$SourceSnapshotRoot = Join-Path $PrivateRoot "source-snapshot"
$PublicRoot = Join-Path $NewRunRoot "public"
New-Item -ItemType Directory -Path $CoreRoot, $ToolPackRoot, $HarnessRoot, $PlansRoot, $WsbRoot, $EvidenceParent, $ControllerRoot, $PublicRoot | Out-Null

$SourceSnapshotSha256 = New-RepositorySourceSnapshot `
    $ControllerGit `
    $ReleaseCommit `
    $SourceSnapshotArchive `
    $SourceSnapshotRoot `
    $Engines.ue58.embeddedPython `
    $ResolvedExtractor
$SnapshotScriptsRoot = Resolve-RealLocalPath (Join-Path $SourceSnapshotRoot "scripts") "snapshot scripts" "Container"
$SnapshotGuestScript = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "run-clean-host-acceptance-guest.ps1") "snapshot guest script" "Leaf"
$SnapshotExtractor = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "extract-verified-artifact.py") "snapshot safe extractor" "Leaf"
$SnapshotHostScript = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "invoke-clean-host-acceptance.ps1") "snapshot host script" "Leaf"
$SnapshotPackager = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "package-tool-pack.py") "snapshot Tool Pack packager" "Leaf"
$SnapshotValidator = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "validate-clean-host-evidence.mjs") "snapshot evidence validator" "Leaf"
$SnapshotRegistry = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "ue-release-variants.json") "snapshot variant registry" "Leaf"
$SnapshotVariantModule = Resolve-RealLocalPath (Join-Path $SnapshotScriptsRoot "ue-release-variants.mjs") "snapshot variant module" "Leaf"

$ControllerHostScript = Join-Path $ControllerRoot "invoke-clean-host-acceptance.ps1"
$ControllerValidator = Join-Path $ControllerRoot "validate-clean-host-evidence.mjs"
$ControllerRegistry = Join-Path $ControllerRoot "ue-release-variants.json"
$ControllerVariantModule = Join-Path $ControllerRoot "ue-release-variants.mjs"
Copy-Item -LiteralPath $SnapshotHostScript -Destination $ControllerHostScript
Copy-Item -LiteralPath $SnapshotValidator -Destination $ControllerValidator
Copy-Item -LiteralPath $SnapshotRegistry -Destination $ControllerRegistry
Copy-Item -LiteralPath $SnapshotVariantModule -Destination $ControllerVariantModule

foreach ($Core in $CoreInputs) {
    $Destination = Join-Path $CoreRoot $Core.subject
    Copy-Item -LiteralPath $Core.sourcePath -Destination $Destination
    if ((Get-Sha256 $Destination) -cne $Core.sha256) {
        Fail "a copied core archive changed bytes."
    }
}
$GuestScriptCopy = Join-Path $HarnessRoot "run-clean-host-acceptance-guest.ps1"
$ExtractorCopy = Join-Path $HarnessRoot "extract-verified-artifact.py"
Copy-Item -LiteralPath $SnapshotGuestScript -Destination $GuestScriptCopy
Copy-Item -LiteralPath $SnapshotExtractor -Destination $ExtractorCopy
$HarnessInputs = [ordered]@{
    guestScript = [ordered]@{
        subject = "run-clean-host-acceptance-guest.ps1"
        relativePath = "harness/run-clean-host-acceptance-guest.ps1"
        sha256 = Get-Sha256 $GuestScriptCopy
    }
    extractor = [ordered]@{
        subject = "extract-verified-artifact.py"
        relativePath = "harness/extract-verified-artifact.py"
        sha256 = Get-Sha256 $ExtractorCopy
    }
}

$PackDefinitions = @(
    [ordered]@{ id = "AssetToolsFixture"; source = "tests/fixtures/ue-tool-packs/AssetToolsFixture" },
    [ordered]@{ id = "LevelToolsFixture"; source = "tests/fixtures/ue-tool-packs/LevelToolsFixture" },
    [ordered]@{ id = "ExampleAssetTools"; source = "examples/tool-packs/ExampleAssetTools" }
)
$PackBuildParent = Join-Path $PrivateRoot "tool-pack-build"
New-Item -ItemType Directory -Path $PackBuildParent | Out-Null
$PackagingPython = $Engines.ue58.embeddedPython
$ToolPackInputs = @()
foreach ($Definition in $PackDefinitions) {
    $Source = Resolve-RealLocalPath (Join-Path $SourceSnapshotRoot $Definition.source) "$($Definition.id) snapshot source" "Container"
    $PackOutput = Join-Path $PackBuildParent $Definition.id
    $OutputLines = @(& $PackagingPython $SnapshotPackager --plugin-dir $Source --output-dir $PackOutput --format json)
    if ($LASTEXITCODE -ne 0 -or $OutputLines.Count -eq 0) {
        Fail "$($Definition.id) packaging failed."
    }
    $OutputText = $OutputLines -join "`n"
    if ($StrictUtf8.GetByteCount($OutputText) -gt $MaximumControllerJsonBytes) {
        Fail "$($Definition.id) packager output exceeds the JSON size limit."
    }
    try {
        Assert-StrictJsonGrammar $OutputText "$($Definition.id) packager output"
        $PackageResult = $OutputText | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Fail "$($Definition.id) packager output is invalid."
    }
    Assert-ExactKeys $PackageResult @(
        "artifact", "schemaVersion", "toolPack", "unrealVariant", "valid"
    ) "$($Definition.id) packager output"
    Assert-ExactValue $PackageResult.schemaVersion 1 "$($Definition.id) packager schemaVersion"
    Assert-ExactValue $PackageResult.valid $true "$($Definition.id) packager valid"
    Assert-ExactKeys $PackageResult.artifact @(
        "archiveName", "archiveSha256", "manifestName", "manifestSha256", "sha256Name"
    ) "$($Definition.id) packager artifact"
    $ArchiveName = [string]$PackageResult.artifact.archiveName
    if ($ArchiveName -cne "$($Definition.id)-1.0.0-ToolPack.zip") {
        Fail "$($Definition.id) archive identity is unexpected."
    }
    $ArchivePath = Resolve-RealLocalPath (Join-Path $PackOutput $ArchiveName) "$($Definition.id) archive" "Leaf"
    $Digest = Get-Sha256 $ArchivePath
    if ([string]$PackageResult.artifact.archiveSha256 -cne $Digest) {
        Fail "$($Definition.id) package digest is invalid."
    }
    $Destination = Join-Path $ToolPackRoot $ArchiveName
    Copy-Item -LiteralPath $ArchivePath -Destination $Destination
    if ((Get-Sha256 $Destination) -cne $Digest) {
        Fail "a copied Tool Pack archive changed bytes."
    }
    $ToolPackInputs += [ordered]@{
        id = [string]$Definition.id
        subject = $ArchiveName
        relativePath = "tool-packs/$ArchiveName"
        sha256 = $Digest
    }
}

$WsbPaths = [ordered]@{}
foreach ($Variant in $Variants) {
    $VariantId = [string]$Variant.id
    $EvidenceRoot = Join-Path $EvidenceParent $VariantId
    New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
    $Plan = [ordered]@{
        schemaVersion = 1
        runId = $RunId
        sourceKind = $SourceKind
        release = [ordered]@{ tag = $ReleaseTag; commit = $ReleaseCommit }
        target = [ordered]@{
            variantId = $VariantId
            releaseVariant = [string]$Variant.releaseVariant
            engineAssociation = [string]$Variant.engineAssociation
            engine = [ordered]@{
                majorVersion = [int]$Variant.engine.majorVersion
                minorVersion = [int]$Variant.engine.minorVersion
                patchVersion = [int]$Variant.engine.patchVersion
                changelist = [int]$Variant.engine.changelist
                compatibleChangelist = [int]$Variant.engine.compatibleChangelist
                branchName = [string]$Variant.engine.branchName
                buildId = [string]$Variant.engine.buildId
            }
        }
        harness = $HarnessInputs
        coreArchives = @($CoreInputs | ForEach-Object {
            [ordered]@{
                variantId = $_.variantId
                subject = $_.subject
                relativePath = "core/$($_.subject)"
                sha256 = $_.sha256
                expectedEngineVersion = $_.expectedEngineVersion
                expectedBuildId = $_.expectedBuildId
            }
        })
        toolPacks = $ToolPackInputs
    }
    $PlanPath = Join-Path $PlansRoot "$VariantId.json"
    Write-CanonicalJson $PlanPath $Plan
    $WsbPath = Join-Path $WsbRoot "$VariantId.wsb"
    New-WsbConfiguration $WsbPath $InputRoot $Engines[$VariantId].root $EvidenceRoot $VariantId $SandboxMemoryMB
    $WsbPaths[$VariantId] = $WsbPath
}

$PlanManifestRecords = @($Variants | ForEach-Object {
    $VariantId = [string]$_.id
    $PlanPath = Join-Path $PlansRoot "$VariantId.json"
    [ordered]@{
        variantId = $VariantId
        subject = "$VariantId.json"
        sha256 = Get-Sha256 $PlanPath
    }
})
$ConfigurationManifestRecords = @($Variants | ForEach-Object {
    $VariantId = [string]$_.id
    [ordered]@{
        variantId = $VariantId
        subject = "$VariantId.wsb"
        sha256 = Get-Sha256 $WsbPaths[$VariantId]
    }
})
$RunManifest = [ordered]@{
    schemaVersion = 1
    runId = $RunId
    runRootName = [System.IO.Path]::GetFileName($NewRunRoot)
    release = [ordered]@{
        tag = $ReleaseTag
        commit = $ReleaseCommit
        sourceKind = $SourceKind
    }
    sourceSnapshot = [ordered]@{
        subject = "source-snapshot.zip"
        sha256 = $SourceSnapshotSha256
    }
    controller = [ordered]@{
        hostScript = [ordered]@{
            subject = "invoke-clean-host-acceptance.ps1"
            sha256 = Get-Sha256 $ControllerHostScript
        }
        validator = [ordered]@{
            subject = "validate-clean-host-evidence.mjs"
            sha256 = Get-Sha256 $ControllerValidator
        }
        variantRegistry = [ordered]@{
            subject = "ue-release-variants.json"
            sha256 = Get-Sha256 $ControllerRegistry
        }
        variantModule = [ordered]@{
            subject = "ue-release-variants.mjs"
            sha256 = Get-Sha256 $ControllerVariantModule
        }
    }
    harness = $HarnessInputs
    plans = $PlanManifestRecords
    configurations = $ConfigurationManifestRecords
}
$RunManifestPath = Join-Path $PrivateRoot "run-manifest.json"
Write-Utf8FileNoOverwrite `
    -Path $RunManifestPath `
    -Value (($RunManifest | ConvertTo-Json -Depth 20) + "`n") `
    -Label "private run manifest"
$RunManifestSha256 = Get-Sha256 $RunManifestPath

if ($Launch) {
    try {
        $Feature = Get-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM"
    }
    catch {
        Fail "Windows Sandbox feature state could not be read."
    }
    if ([string]$Feature.State -cne "Enabled") {
        Fail "Windows Sandbox is not enabled; this script never enables Windows features."
    }
    $SandboxCommand = Get-Command WindowsSandbox.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $SandboxCommand) {
        Fail "WindowsSandbox.exe is unavailable."
    }
    foreach ($Variant in $Variants) {
        $VariantId = [string]$Variant.id
        if (@(Get-Process -Name "WindowsSandbox", "WindowsSandboxClient" -ErrorAction SilentlyContinue).Count -ne 0) {
            Fail "another Windows Sandbox instance is already running."
        }
        $BindingPath = Join-Path $EvidenceParent "$VariantId/guest-binding.json"
        $FailurePath = Join-Path $EvidenceParent "$VariantId/guest-failure.json"
        $QuotedConfiguration = '"{0}"' -f $WsbPaths[$VariantId]
        $SandboxLaunchProcess = Start-Process `
            -FilePath $SandboxCommand.Source `
            -ArgumentList $QuotedConfiguration `
            -PassThru
        $LaunchStarted = [DateTime]::UtcNow
        $ObservedSandboxProcess = $false
        $Deadline = [DateTime]::UtcNow.AddMinutes(90)
        while (-not (Test-Path -LiteralPath $BindingPath -PathType Leaf) -and
               -not (Test-Path -LiteralPath $FailurePath -PathType Leaf)) {
            if ([DateTime]::UtcNow -ge $Deadline) {
                Fail "$VariantId Sandbox timed out without a result."
            }
            $ActiveSandboxProcesses = @(
                Get-Process -Name "WindowsSandbox", "WindowsSandboxClient" -ErrorAction SilentlyContinue
            )
            if ($ActiveSandboxProcesses.Count -ne 0) {
                $ObservedSandboxProcess = $true
            }
            elseif ($ObservedSandboxProcess) {
                Fail "$VariantId Sandbox closed before writing a completion or failure sentinel."
            }
            elseif ($SandboxLaunchProcess.HasExited -and
                [DateTime]::UtcNow -ge $LaunchStarted.AddSeconds(30)) {
                Fail "$VariantId Sandbox launcher exited without creating a visible Sandbox process or sentinel."
            }
            Start-Sleep -Seconds 2
        }
        if (Test-Path -LiteralPath $FailurePath -PathType Leaf) {
            $Failure = Read-JsonFile $FailurePath "$VariantId private failure"
            Assert-ExactKeys $Failure @("schemaVersion", "result", "reasonCode") "$VariantId private failure"
            Assert-ExactValue $Failure.schemaVersion 1 "$VariantId private failure.schemaVersion"
            Assert-ExactValue $Failure.result "failure" "$VariantId private failure.result"
            if ($null -eq $Failure.reasonCode -or
                $Failure.reasonCode.GetType() -ne [string] -or
                $AllowedGuestFailureCodes -cnotcontains [string]$Failure.reasonCode) {
                Fail "$VariantId Sandbox failure document is outside the closed contract."
            }
            Fail "$VariantId Sandbox reported reason code $([string]$Failure.reasonCode)."
        }
        $CloseDeadline = [DateTime]::UtcNow.AddMinutes(2)
        while (@(Get-Process -Name "WindowsSandbox", "WindowsSandboxClient" -ErrorAction SilentlyContinue).Count -ne 0) {
            if ([DateTime]::UtcNow -ge $CloseDeadline) {
                Fail "$VariantId Sandbox did not close after writing evidence."
            }
            Start-Sleep -Seconds 2
        }
        $SandboxLaunchProcess.Dispose()
    }
    Write-Output ((Invoke-Finalize $NewRunRoot) | ConvertTo-Json -Compress)
    exit 0
}

Write-Output ([ordered]@{
    schemaVersion = 1
    result = "prepared"
    runId = $RunId
    runRoot = $NewRunRoot
    manifestSha256 = $RunManifestSha256
    configurations = $WsbPaths
} | ConvertTo-Json -Compress)
