[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Plan,

    [Parameter(Mandatory = $true)]
    [string]$EvidenceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ReleaseTag = "v0.3.0"
$PluginVersion = 4
$PluginVersionName = "0.3.0"
$InputRoot = "C:\UEWebUI\Input"
$MappedEngineRoot = "C:\UEWebUI\Engine"
$MappedEvidenceRoot = "C:\UEWebUI\Evidence"
$StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$MaximumJsonBytes = 1MB
$MaximumLogBytes = 128MB
$MaximumJsonNestingDepth = 64
$StrictJsonNumberRegex = [regex]'\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
$SandboxIdentityVerified = $false
$SandboxVerified = $false
$SuccessWritten = $false
$ExitCode = 1
$FailureStageCode = "guest_environment_preflight_failed"
$AllowedFailureStageCodes = @(
    "guest_environment_preflight_failed",
    "guest_plan_validation_failed",
    "guest_artifact_validation_failed",
    "guest_matrix_preflight_failed",
    "guest_editor_execution_failed",
    "guest_evidence_emission_failed",
    "guest_internal_failed"
)

$Variants = @(
    [PSCustomObject][ordered]@{
        id = "ue54"
        releaseVariant = "UE54-Win64"
        engineAssociation = "5.4"
        engine = [PSCustomObject][ordered]@{
            majorVersion = 5
            minorVersion = 4
            patchVersion = 4
            changelist = 35576357
            compatibleChangelist = 33043543
            branchName = "++UE5+Release-5.4"
            buildId = "33043543"
        }
    },
    [PSCustomObject][ordered]@{
        id = "ue55"
        releaseVariant = "UE55-Win64"
        engineAssociation = "5.5"
        engine = [PSCustomObject][ordered]@{
            majorVersion = 5
            minorVersion = 5
            patchVersion = 4
            changelist = 40574608
            compatibleChangelist = 37670630
            branchName = "++UE5+Release-5.5"
            buildId = "37670630"
        }
    },
    [PSCustomObject][ordered]@{
        id = "ue58"
        releaseVariant = "UE58-Win64"
        engineAssociation = "5.8"
        engine = [PSCustomObject][ordered]@{
            majorVersion = 5
            minorVersion = 8
            patchVersion = 0
            changelist = 55116800
            compatibleChangelist = 0
            branchName = "++UE5+Release-5.8"
            buildId = "55116800"
        }
    }
)

$ToolPackDefinitions = @(
    [PSCustomObject][ordered]@{
        id = "AssetToolsFixture"
        subject = "AssetToolsFixture-1.0.0-ToolPack.zip"
        packId = "com.openai.fixture.asset-tools"
        manifestSchemaVersion = 1
    },
    [PSCustomObject][ordered]@{
        id = "LevelToolsFixture"
        subject = "LevelToolsFixture-1.0.0-ToolPack.zip"
        packId = "com.openai.fixture.level-tools"
        manifestSchemaVersion = 1
    },
    [PSCustomObject][ordered]@{
        id = "ExampleAssetTools"
        subject = "ExampleAssetTools-1.0.0-ToolPack.zip"
        packId = "com.example.asset-tools"
        manifestSchemaVersion = 2
    }
)

function Fail([string]$Message) {
    throw "Clean-host guest failed: $Message"
}

function Test-FileSystemEntry([string]$LiteralPath) {
    try {
        Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop | Out-Null
        return $true
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return $false
    }
}

function Assert-ExactKeys($Value, [string[]]$Expected, [string]$Label) {
    if ($null -eq $Value) {
        Fail "$Label is missing."
    }
    $ActualKeys = @($Value.PSObject.Properties.Name | Sort-Object)
    $ExpectedKeys = @($Expected | Sort-Object)
    if (($ActualKeys -join "`n") -cne ($ExpectedKeys -join "`n")) {
        Fail "$Label does not use the closed schema."
    }
}

function Assert-ExactChildNames([string]$Directory, [string[]]$Expected, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        Fail "$Label is unavailable."
    }
    $ActualNames = @(
        Get-ChildItem -LiteralPath $Directory -Force | ForEach-Object { $_.Name } | Sort-Object
    )
    $ExpectedNames = @($Expected | Sort-Object)
    if (($ActualNames -join "`n") -cne ($ExpectedNames -join "`n")) {
        Fail "$Label does not contain the closed input set."
    }
}

function Read-StrictJsonStringToken(
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

function Read-StrictJsonValue(
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
        if ($Frames.Count -ge $MaximumJsonNestingDepth) {
            Fail "$Label exceeds the JSON nesting limit."
        }
        if ($Character -eq '{') {
            $Frames.Push([PSCustomObject]@{
                type = "object"
                state = "key-or-end"
                keys = @{}
            })
        }
        else {
            $Frames.Push([PSCustomObject]@{
                type = "array"
                state = "value-or-end"
                keys = $null
            })
        }
        $Index.Value = $Position + 1
        return
    }
    if ($Character -eq '"') {
        Read-StrictJsonStringToken $Text $Index $Label | Out-Null
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
        $NumberMatch = $StrictJsonNumberRegex.Match($Text, $Position)
        if ($NumberMatch.Success -and $NumberMatch.Index -eq $Position) {
            $Index.Value = $Position + $NumberMatch.Length
            return
        }
    }
    Fail "$Label contains a value outside the strict JSON grammar."
}

function Assert-NoDuplicateJsonKeys([string]$Text, [string]$Label) {
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
            Read-StrictJsonValue $Text ([ref]$Index) $Frames $Label
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
                $Token = Read-StrictJsonStringToken $Text ([ref]$Index) $Label
                $Key = [string]$Token.value
                # PowerShell object properties are case-insensitive, so reject
                # case-only collisions as well as exact duplicate JSON keys.
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
                Read-StrictJsonValue $Text ([ref]$Index) $Frames $Label
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
            Read-StrictJsonValue $Text ([ref]$Index) $Frames $Label
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

function Read-StrictJson([string]$Path, [string]$Label) {
    try {
        $ResolvedJson = Resolve-RegularLeaf $Path $Label
        $JsonItem = Get-Item -LiteralPath $ResolvedJson -Force -ErrorAction Stop
        if ($JsonItem.Length -gt $MaximumJsonBytes) {
            Fail "$Label exceeds the JSON size limit."
        }
        $Text = [System.IO.File]::ReadAllText($ResolvedJson, $StrictUtf8)
        if ([string]::IsNullOrWhiteSpace($Text)) {
            Fail "$Label is empty."
        }
        $TrimmedText = $Text.Trim()
        if (-not $TrimmedText.StartsWith("{", [System.StringComparison]::Ordinal) -or
            -not $TrimmedText.EndsWith("}", [System.StringComparison]::Ordinal)) {
            Fail "$Label JSON document must be an object."
        }
        Assert-NoDuplicateJsonKeys $Text $Label
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Fail "$Label is not strict UTF-8 JSON."
    }
}

function Get-CanonicalSha256([string]$Path) {
    $Digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    return "sha256:$Digest"
}

function Test-ContainedPath([string]$Parent, [string]$Child) {
    $ParentPrefix = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
    $ChildPath = [System.IO.Path]::GetFullPath($Child)
    return ($ChildPath + "\").StartsWith(
        $ParentPrefix,
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-RegularLeaf([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path) -or
        $Path -notmatch '^[A-Za-z]:[\\/]' -or
        $Path.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        $Path.StartsWith("\\?\", [System.StringComparison]::Ordinal) -or
        $Path.StartsWith("\??\", [System.StringComparison]::Ordinal) -or
        $Path.Contains(";")) {
        Fail "$Label must be an absolute local path."
    }
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    if ($FullPath.Length -lt 3 -or $FullPath.Substring(2).Contains(":")) {
        Fail "$Label contains an unsupported stream or device path."
    }
    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        Fail "$Label is unavailable."
    }
    $Item = Get-Item -LiteralPath $FullPath -Force
    if ($Item.PSIsContainer -or
        ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $Item.Length -le 0) {
        Fail "$Label is not a non-empty regular file."
    }
    return $Item.FullName
}

function Resolve-InputFile([string]$RelativePath, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Contains("\") -or
        $RelativePath.Contains(":") -or
        $RelativePath.Contains(";") -or
        $RelativePath.Split("/") -contains ".." -or
        $RelativePath.Split("/") -contains "." -or
        $RelativePath.Split("/") -contains "") {
        Fail "$Label relative path is invalid."
    }
    $Candidate = Join-Path $InputRoot ($RelativePath.Replace("/", "\"))
    $Resolved = Resolve-RegularLeaf $Candidate $Label
    if (-not (Test-ContainedPath $InputRoot $Resolved)) {
        Fail "$Label escaped the read-only input root."
    }
    return $Resolved
}

function Assert-ExactValue($Actual, $Expected, [string]$Label) {
    if ($null -eq $Actual -or
        $null -eq $Expected -or
        $Actual.GetType() -ne $Expected.GetType() -or
        -not $Actual.Equals($Expected)) {
        Fail "$Label does not match the closed contract."
    }
}

function Assert-NetworkDisabled {
    try {
        $DefaultRoutes = @(
            Get-NetRoute -ErrorAction Stop | Where-Object {
                $_.DestinationPrefix -eq "0.0.0.0/0" -or
                $_.DestinationPrefix -eq "::/0"
            }
        )
    }
    catch {
        Fail "the guest cannot prove that networking is disabled."
    }
    if ($DefaultRoutes.Count -ne 0) {
        Fail "the guest has an active default network route."
    }
}

function Get-ResolvedCommands([string[]]$Names) {
    $Commands = @()
    foreach ($Name in $Names) {
        $Commands += @(Get-Command $Name -All -ErrorAction SilentlyContinue)
    }
    return @($Commands)
}

function Assert-SystemPythonAbsent {
    $Commands = @(Get-ResolvedCommands @("python", "python.exe", "python3", "python3.exe", "py", "py.exe"))
    foreach ($Command in $Commands) {
        $Source = [string]$Command.Source
        if ([string]::IsNullOrWhiteSpace($Source)) {
            Fail "a system Python command is available."
        }
        $WindowsAppsPrefix = [System.IO.Path]::GetFullPath(
            (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps")).TrimEnd("\") + "\"
        $FullSource = [System.IO.Path]::GetFullPath($Source)
        if (-not $FullSource.StartsWith(
            $WindowsAppsPrefix,
            [System.StringComparison]::OrdinalIgnoreCase)) {
            Fail "a system Python runtime is available."
        }
    }
    try {
        $PythonPackages = @(
            Get-AppxPackage -Name "PythonSoftwareFoundation.Python*" -ErrorAction Stop
        )
    }
    catch {
        Fail "the guest cannot prove that packaged system Python is absent."
    }
    if ($PythonPackages.Count -ne 0) {
        Fail "a packaged system Python runtime is installed."
    }
    foreach ($Pattern in @(
        "C:\Python*\python.exe",
        "C:\Program Files\Python*\python.exe",
        "C:\Program Files (x86)\Python*\python.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python*\python.exe")
    )) {
        if (@(Get-Item -Path $Pattern -ErrorAction SilentlyContinue).Count -ne 0) {
            Fail "a system Python runtime is installed."
        }
    }
}

function Test-EnvironmentVariablePresent([string[]]$Names) {
    foreach ($Name in $Names) {
        if (-not [string]::IsNullOrWhiteSpace(
            [Environment]::GetEnvironmentVariable($Name, "Process"))) {
            return $true
        }
    }
    return $false
}

function Test-RegistryInstallationData([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path -ErrorAction Stop)) {
            return $false
        }
        $Key = Get-Item -LiteralPath $Path -ErrorAction Stop
        return ($Key.GetValueNames().Count -ne 0 -or $Key.GetSubKeyNames().Count -ne 0)
    }
    catch {
        Fail "the guest cannot prove that Visual Studio registry state is absent."
    }
}

function Get-StandardVisualStudioRoots {
    $Roots = @()
    foreach ($ProgramFilesRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) {
            continue
        }
        try {
            $Roots += @(
                Get-ChildItem -LiteralPath $ProgramFilesRoot -Directory -Filter "Microsoft Visual Studio*" -ErrorAction Stop |
                    ForEach-Object { $_.FullName }
            )
        }
        catch {
            Fail "the guest cannot inspect standard Visual Studio installation roots."
        }
    }
    return @($Roots | Sort-Object -Unique)
}

function Test-NamedFileUnderRoot(
    [string]$Root,
    [string[]]$Names,
    [string]$Label
) {
    try {
        if (-not (Test-Path -LiteralPath $Root -PathType Container -ErrorAction Stop)) {
            return $false
        }
        foreach ($Name in $Names) {
            $Match = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name -ErrorAction Stop |
                Select-Object -First 1
            if ($null -ne $Match) {
                return $true
            }
        }
        return $false
    }
    catch {
        Fail "the guest cannot inspect $Label development files."
    }
}

function Get-WindowsKitRoots {
    $Roots = @()
    foreach ($ProgramFilesRoot in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if (-not [string]::IsNullOrWhiteSpace($ProgramFilesRoot)) {
            $Roots += Join-Path $ProgramFilesRoot "Windows Kits\10"
        }
    }
    foreach ($RegistryPath in @(
        "HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots"
    )) {
        try {
            if (-not (Test-Path -LiteralPath $RegistryPath -ErrorAction Stop)) {
                continue
            }
            $Key = Get-Item -LiteralPath $RegistryPath -ErrorAction Stop
            foreach ($Name in $Key.GetValueNames()) {
                if ($Name -notmatch '^KitsRoot[0-9]*$') {
                    continue
                }
                $Value = [string]$Key.GetValue($Name)
                if (-not [string]::IsNullOrWhiteSpace($Value)) {
                    $Roots += $Value
                }
            }
        }
        catch {
            Fail "the guest cannot prove that Windows SDK registry roots are absent."
        }
    }
    return @($Roots | Sort-Object -Unique)
}

function Assert-ConsumerBaseline {
    if (@(Get-ResolvedCommands @("node", "node.exe")).Count -ne 0) {
        Fail "a Node.js command is available in the clean guest."
    }
    if (@(Get-ResolvedCommands @("npm", "npm.cmd", "npm.ps1")).Count -ne 0) {
        Fail "an npm command is available in the clean guest."
    }
    Assert-SystemPythonAbsent

    $CompilerPresent = @(
        Get-ResolvedCommands @("cl", "cl.exe", "nmake", "nmake.exe")
    ).Count -ne 0
    if (Test-EnvironmentVariablePresent @("VCINSTALLDIR", "VCToolsInstallDir")) {
        $CompilerPresent = $true
    }

    $VisualStudioPresent = $false
    $VisualStudioRoots = @(Get-StandardVisualStudioRoots)
    if ($VisualStudioRoots.Count -ne 0 -or
        @(Get-ResolvedCommands @("vswhere", "vswhere.exe", "devenv", "devenv.exe")).Count -ne 0 -or
        (Test-EnvironmentVariablePresent @("VSINSTALLDIR"))) {
        $VisualStudioPresent = $true
    }
    foreach ($Root in $VisualStudioRoots) {
        if (Test-NamedFileUnderRoot $Root @("cl.exe", "nmake.exe") "MSVC") {
            $CompilerPresent = $true
        }
    }
    foreach ($ProgramFilesRoot in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) {
            continue
        }
        $LegacyBuildToolsRoot = Join-Path $ProgramFilesRoot "Microsoft Visual C++ Build Tools"
        if (Test-NamedFileUnderRoot $LegacyBuildToolsRoot @("cl.exe", "nmake.exe") "legacy MSVC") {
            $CompilerPresent = $true
        }
    }
    $ProgramDataInstances = "C:\ProgramData\Microsoft\VisualStudio\Packages\_Instances"
    try {
        if ((Test-Path -LiteralPath $ProgramDataInstances -PathType Container -ErrorAction Stop) -and
            @(Get-ChildItem -LiteralPath $ProgramDataInstances -Force -ErrorAction Stop).Count -ne 0) {
            $VisualStudioPresent = $true
        }
    }
    catch {
        Fail "the guest cannot inspect Visual Studio instance state."
    }
    foreach ($RegistryPath in @(
        "HKLM:\SOFTWARE\Microsoft\VisualStudio\Setup",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\Setup",
        "HKLM:\SOFTWARE\Microsoft\VisualStudio\SxS",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\SxS"
    )) {
        if (Test-RegistryInstallationData $RegistryPath) {
            $VisualStudioPresent = $true
        }
    }

    $WindowsSdkDevelopmentFilesPresent = Test-EnvironmentVariablePresent @(
        "WindowsSdkDir", "WindowsSDKVersion")
    foreach ($KitRoot in @(Get-WindowsKitRoots)) {
        if (Test-NamedFileUnderRoot $KitRoot @("Windows.h", "Kernel32.Lib", "rc.exe") "Windows SDK") {
            $WindowsSdkDevelopmentFilesPresent = $true
        }
    }

    if ($VisualStudioPresent) {
        Fail "a Visual Studio installation is present in the clean guest."
    }
    if ($CompilerPresent) {
        Fail "an MSVC compiler command or payload is present in the clean guest."
    }
    if ($WindowsSdkDevelopmentFilesPresent) {
        Fail "Windows SDK development files are present in the clean guest."
    }
    return [ordered]@{
        nodeCommandAbsent = $true
        npmCommandAbsent = $true
        systemPythonRuntimeAbsent = $true
        visualStudioInstallationAbsent = $true
        msvcCompilerAbsent = $true
        windowsSdkDevelopmentFilesAbsent = $true
    }
}

function Assert-InputLayout {
    Assert-ExactChildNames $InputRoot @("core", "harness", "plans", "tool-packs") "input root"
    Assert-ExactChildNames (Join-Path $InputRoot "core") @(
        "UnrealEditorWebUI-v0.3.0-UE54-Win64.zip",
        "UnrealEditorWebUI-v0.3.0-UE55-Win64.zip",
        "UnrealEditorWebUI-v0.3.0-UE58-Win64.zip"
    ) "core input directory"
    Assert-ExactChildNames (Join-Path $InputRoot "tool-packs") @(
        "AssetToolsFixture-1.0.0-ToolPack.zip",
        "LevelToolsFixture-1.0.0-ToolPack.zip",
        "ExampleAssetTools-1.0.0-ToolPack.zip"
    ) "Tool Pack input directory"
    Assert-ExactChildNames (Join-Path $InputRoot "harness") @(
        "extract-verified-artifact.py",
        "run-clean-host-acceptance-guest.ps1"
    ) "guest harness directory"
    Assert-ExactChildNames (Join-Path $InputRoot "plans") @("ue54.json", "ue55.json", "ue58.json") "plan directory"
}

function Assert-Plan($PlanDocument) {
    Assert-ExactKeys $PlanDocument @(
        "schemaVersion", "runId", "sourceKind", "release", "harness", "target", "coreArchives", "toolPacks"
    ) "plan"
    Assert-ExactValue $PlanDocument.schemaVersion 1 "plan.schemaVersion"
    if ([string]$PlanDocument.runId -cnotmatch "^[0-9a-f]{32}$") {
        Fail "plan.runId is invalid."
    }
    if ([string]$PlanDocument.sourceKind -cne "candidate" -and
        [string]$PlanDocument.sourceKind -cne "published") {
        Fail "plan.sourceKind is invalid."
    }
    Assert-ExactKeys $PlanDocument.release @("tag", "commit") "plan.release"
    Assert-ExactValue $PlanDocument.release.tag $ReleaseTag "plan.release.tag"
    if ([string]$PlanDocument.release.commit -cnotmatch "^[0-9a-f]{40}$") {
        Fail "plan.release.commit is invalid."
    }
    Assert-ExactKeys $PlanDocument.harness @("guestScript", "extractor") "plan.harness"
    foreach ($HarnessEntry in @(
        [PSCustomObject]@{
            name = "guestScript"
            subject = "run-clean-host-acceptance-guest.ps1"
            relativePath = "harness/run-clean-host-acceptance-guest.ps1"
        },
        [PSCustomObject]@{
            name = "extractor"
            subject = "extract-verified-artifact.py"
            relativePath = "harness/extract-verified-artifact.py"
        }
    )) {
        $HarnessValue = $PlanDocument.harness.($HarnessEntry.name)
        Assert-ExactKeys $HarnessValue @("subject", "relativePath", "sha256") "plan.harness.$($HarnessEntry.name)"
        Assert-ExactValue $HarnessValue.subject $HarnessEntry.subject "plan.harness.$($HarnessEntry.name).subject"
        Assert-ExactValue $HarnessValue.relativePath $HarnessEntry.relativePath "plan.harness.$($HarnessEntry.name).relativePath"
        if ([string]$HarnessValue.sha256 -cnotmatch "^sha256:[0-9a-f]{64}$") {
            Fail "plan.harness.$($HarnessEntry.name).sha256 is invalid."
        }
    }
    Assert-ExactKeys $PlanDocument.target @(
        "variantId", "releaseVariant", "engineAssociation", "engine"
    ) "plan.target"
    Assert-ExactKeys $PlanDocument.target.engine @(
        "majorVersion", "minorVersion", "patchVersion", "changelist",
        "compatibleChangelist", "branchName", "buildId"
    ) "plan.target.engine"
    $TargetVariant = @($Variants | Where-Object { $_.id -ceq [string]$PlanDocument.target.variantId })
    if ($TargetVariant.Count -ne 1) {
        Fail "plan.target.variantId is outside the closed set."
    }
    $Target = $TargetVariant[0]
    Assert-ExactValue $PlanDocument.target.releaseVariant $Target.releaseVariant "plan.target.releaseVariant"
    Assert-ExactValue $PlanDocument.target.engineAssociation $Target.engineAssociation "plan.target.engineAssociation"
    foreach ($Name in @(
        "majorVersion", "minorVersion", "patchVersion", "changelist", "compatibleChangelist"
    )) {
        Assert-ExactValue $PlanDocument.target.engine.$Name $Target.engine.$Name "plan.target.engine.$Name"
    }
    Assert-ExactValue $PlanDocument.target.engine.branchName $Target.engine.branchName "plan.target.engine.branchName"
    Assert-ExactValue $PlanDocument.target.engine.buildId $Target.engine.buildId "plan.target.engine.buildId"

    $CorePlans = @($PlanDocument.coreArchives)
    if ($CorePlans.Count -ne 3) {
        Fail "plan.coreArchives must contain the closed set."
    }
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $Variant = $Variants[$Index]
        $CorePlan = $CorePlans[$Index]
        Assert-ExactKeys $CorePlan @(
            "variantId", "subject", "relativePath", "sha256", "expectedEngineVersion", "expectedBuildId"
        ) "plan.coreArchives[$Index]"
        $ExpectedSubject = "UnrealEditorWebUI-$ReleaseTag-$($Variant.releaseVariant).zip"
        Assert-ExactValue $CorePlan.variantId $Variant.id "plan.coreArchives[$Index].variantId"
        Assert-ExactValue $CorePlan.subject $ExpectedSubject "plan.coreArchives[$Index].subject"
        Assert-ExactValue $CorePlan.relativePath "core/$ExpectedSubject" "plan.coreArchives[$Index].relativePath"
        if ([string]$CorePlan.sha256 -cnotmatch "^sha256:[0-9a-f]{64}$") {
            Fail "plan.coreArchives[$Index].sha256 is invalid."
        }
        Assert-ExactValue $CorePlan.expectedEngineVersion "$($Variant.engineAssociation).0" "plan.coreArchives[$Index].expectedEngineVersion"
        Assert-ExactValue $CorePlan.expectedBuildId $Variant.engine.buildId "plan.coreArchives[$Index].expectedBuildId"
    }

    $PackPlans = @($PlanDocument.toolPacks)
    if ($PackPlans.Count -ne 3) {
        Fail "plan.toolPacks must contain the closed set."
    }
    for ($Index = 0; $Index -lt $ToolPackDefinitions.Count; $Index++) {
        $Definition = $ToolPackDefinitions[$Index]
        $PackPlan = $PackPlans[$Index]
        Assert-ExactKeys $PackPlan @("id", "subject", "relativePath", "sha256") "plan.toolPacks[$Index]"
        Assert-ExactValue $PackPlan.id $Definition.id "plan.toolPacks[$Index].id"
        Assert-ExactValue $PackPlan.subject $Definition.subject "plan.toolPacks[$Index].subject"
        Assert-ExactValue $PackPlan.relativePath "tool-packs/$($Definition.subject)" "plan.toolPacks[$Index].relativePath"
        if ([string]$PackPlan.sha256 -cnotmatch "^sha256:[0-9a-f]{64}$") {
            Fail "plan.toolPacks[$Index].sha256 is invalid."
        }
    }
    $AllHashes = @($CorePlans | ForEach-Object { [string]$_.sha256 }) +
        @($PackPlans | ForEach-Object { [string]$_.sha256 }) +
        @(
            [string]$PlanDocument.harness.guestScript.sha256,
            [string]$PlanDocument.harness.extractor.sha256
        )
    if (@($AllHashes | Sort-Object -Unique).Count -ne $AllHashes.Count) {
        Fail "plan input hashes must be unique."
    }
    return $Target
}

function Assert-EngineIdentity($Target) {
    $Paths = [ordered]@{
        build = Join-Path $MappedEngineRoot "Engine\Build\Build.version"
        editor = Join-Path $MappedEngineRoot "Engine\Binaries\Win64\UnrealEditor.version"
        modules = Join-Path $MappedEngineRoot "Engine\Binaries\Win64\UnrealEditor.modules"
        editorCmd = Join-Path $MappedEngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
        embeddedPython = Join-Path $MappedEngineRoot "Engine\Binaries\ThirdParty\Python3\Win64\python.exe"
    }
    foreach ($Name in @($Paths.Keys)) {
        $Paths[$Name] = Resolve-RegularLeaf $Paths[$Name] "target engine $Name"
    }
    $Build = Read-StrictJson $Paths.build "target Build.version"
    $Editor = Read-StrictJson $Paths.editor "target UnrealEditor.version"
    $Modules = Read-StrictJson $Paths.modules "target UnrealEditor.modules"
    foreach ($Identity in @($Build, $Editor)) {
        foreach ($Name in @(
            "MajorVersion", "MinorVersion", "PatchVersion", "Changelist", "CompatibleChangelist"
        )) {
            $PlanName = $Name.Substring(0, 1).ToLowerInvariant() + $Name.Substring(1)
            Assert-ExactValue $Identity.$Name $Target.engine.$PlanName "target engine $Name"
        }
        Assert-ExactValue $Identity.BranchName $Target.engine.branchName "target engine BranchName"
        Assert-ExactValue $Identity.IsLicenseeVersion 0 "target engine IsLicenseeVersion"
        Assert-ExactValue $Identity.IsPromotedBuild 1 "target engine IsPromotedBuild"
    }
    Assert-ExactValue $Editor.BuildId $Target.engine.buildId "target editor BuildId"
    Assert-ExactValue $Modules.BuildId $Target.engine.buildId "target module BuildId"
    return [PSCustomObject][ordered]@{
        editorCmd = $Paths.editorCmd
        embeddedPython = $Paths.embeddedPython
    }
}

function Invoke-SafeExtraction(
    [string]$EmbeddedPython,
    [string]$Extractor,
    [string]$Archive,
    [string]$Destination
) {
    if (Test-FileSystemEntry $Destination) {
        Fail "an extraction destination is not fresh."
    }
    $PreviousPreference = $ErrorActionPreference
    $ExtractionExitCode = -1
    try {
        $ErrorActionPreference = "Continue"
        & $EmbeddedPython $Extractor --archive $Archive --destination $Destination --profile package 2>&1 | Out-Null
        $ExtractionExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ExtractionExitCode -ne 0 -or -not (Test-Path -LiteralPath $Destination -PathType Container)) {
        Fail "safe archive extraction failed."
    }
}

function Resolve-OnlyPluginRoot([string]$ExtractionRoot, [string]$ExpectedName, [string]$Label) {
    $Entries = @(Get-ChildItem -LiteralPath $ExtractionRoot -Force)
    if ($Entries.Count -ne 1 -or
        -not $Entries[0].PSIsContainer -or
        $Entries[0].Name -cne $ExpectedName -or
        ($Entries[0].Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "$Label archive does not contain one exact plugin root."
    }
    return $Entries[0].FullName
}

function Assert-CorePackage(
    $CorePlan,
    $Variant,
    [string]$PluginRoot
) {
    $DescriptorPath = Resolve-RegularLeaf (Join-Path $PluginRoot "UnrealEditorWebUI.uplugin") "core descriptor"
    $Descriptor = Read-StrictJson $DescriptorPath "core descriptor"
    Assert-ExactValue $Descriptor.Version $PluginVersion "core descriptor Version"
    Assert-ExactValue $Descriptor.VersionName $PluginVersionName "core descriptor VersionName"
    Assert-ExactValue $Descriptor.EngineVersion "$($Variant.engineAssociation).0" "core descriptor EngineVersion"
    Assert-ExactValue $Descriptor.Installed $true "core descriptor Installed"
    $DescriptorModules = @($Descriptor.Modules)
    if ($DescriptorModules.Count -ne 1 -or
        [string]$DescriptorModules[0].Name -cne "UnrealEditorWebUI" -or
        [string]$DescriptorModules[0].Type -cne "Editor" -or
        [string]$DescriptorModules[0].LoadingPhase -cne "Default") {
        Fail "core descriptor module declaration is invalid."
    }
    $DependencyNames = @(
        @($Descriptor.Plugins) | Where-Object { $_.Enabled -eq $true } | ForEach-Object { [string]$_.Name } | Sort-Object
    )
    if (($DependencyNames -join ",") -cne "PythonScriptPlugin,WebBrowserWidget") {
        Fail "core descriptor engine plugin dependencies are invalid."
    }
    foreach ($Required in @("Web\dist\index.html", "LICENSE", "SourceManifest.json")) {
        Resolve-RegularLeaf (Join-Path $PluginRoot $Required) "core package $Required" | Out-Null
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot "Python") -PathType Container)) {
        Fail "core package Python directory is missing."
    }
    $Binaries = Join-Path $PluginRoot "Binaries\Win64"
    $ModuleManifests = @(Get-ChildItem -LiteralPath $Binaries -File -Filter "*.modules" -ErrorAction SilentlyContinue)
    if ($ModuleManifests.Count -ne 1) {
        Fail "core package must contain exactly one Win64 module manifest."
    }
    $ModuleDocument = Read-StrictJson $ModuleManifests[0].FullName "core package module manifest"
    Assert-ExactKeys $ModuleDocument @("BuildId", "Modules") "core package module manifest"
    Assert-ExactValue $ModuleDocument.BuildId $Variant.engine.buildId "core package module BuildId"
    Assert-ExactKeys $ModuleDocument.Modules @("UnrealEditorWebUI") "core package module mapping"
    Assert-ExactValue $ModuleDocument.Modules.UnrealEditorWebUI "UnrealEditor-UnrealEditorWebUI.dll" "core package DLL mapping"
    $DllPath = Resolve-RegularLeaf (Join-Path $Binaries "UnrealEditor-UnrealEditorWebUI.dll") "core package DLL"
    if ((Get-Item -LiteralPath $DllPath).Length -le 0) {
        Fail "core package DLL is empty."
    }
    Assert-ExactValue $CorePlan.expectedEngineVersion $Descriptor.EngineVersion "core plan descriptor binding"
    Assert-ExactValue $CorePlan.expectedBuildId $ModuleDocument.BuildId "core plan module binding"
    return [PSCustomObject][ordered]@{
        descriptorVersion = [int]$Descriptor.Version
        descriptorVersionName = [string]$Descriptor.VersionName
        descriptorEngineVersion = [string]$Descriptor.EngineVersion
        moduleBuildId = [string]$ModuleDocument.BuildId
    }
}

function Assert-ToolPackPackage(
    $PackPlan,
    $Definition,
    [string]$PluginRoot
) {
    $DescriptorPath = Resolve-RegularLeaf (Join-Path $PluginRoot "$($Definition.id).uplugin") "Tool Pack descriptor"
    $Descriptor = Read-StrictJson $DescriptorPath "Tool Pack descriptor"
    Assert-ExactValue $Descriptor.VersionName "1.0.0" "Tool Pack VersionName"
    Assert-ExactValue $Descriptor.NoCode $true "Tool Pack NoCode"
    if ($Descriptor.PSObject.Properties.Name -contains "Modules") {
        Fail "content-only Tool Pack declares native modules."
    }
    foreach ($ForbiddenDirectory in @("Binaries", "Source", "Intermediate")) {
        if (Test-FileSystemEntry (Join-Path $PluginRoot $ForbiddenDirectory)) {
            Fail "content-only Tool Pack contains a native build directory."
        }
    }
    $ManifestPath = Resolve-RegularLeaf (
        Join-Path $PluginRoot "Content\UnrealEditorWebUI\ToolPack.json") "Tool Pack manifest"
    $DistributionPath = Resolve-RegularLeaf (
        Join-Path $PluginRoot "Content\UnrealEditorWebUI\ToolPackDistribution.json") "Tool Pack distribution manifest"
    if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot "Content\Python") -PathType Container)) {
        Fail "Tool Pack Python payload is missing."
    }
    $Manifest = Read-StrictJson $ManifestPath "Tool Pack manifest"
    Assert-ExactValue $Manifest.schemaVersion $Definition.manifestSchemaVersion "Tool Pack schemaVersion"
    Assert-ExactValue $Manifest.id $Definition.packId "Tool Pack id"
    Assert-ExactValue $Manifest.requiredCoreApi 1 "Tool Pack requiredCoreApi"
    $Distribution = Read-StrictJson $DistributionPath "Tool Pack distribution manifest"
    Assert-ExactValue $Distribution.schemaVersion 1 "Tool Pack distribution schemaVersion"
    Assert-ExactValue $Distribution.format "unreal-editor-webui-tool-pack" "Tool Pack distribution format"
    Assert-ExactValue $Distribution.plugin.name $Definition.id "Tool Pack distribution plugin name"
    Assert-ExactValue $Distribution.plugin.version "1.0.0" "Tool Pack distribution plugin version"
    return [ordered]@{
        id = [string]$PackPlan.id
        subject = [string]$PackPlan.subject
        sha256 = [string]$PackPlan.sha256
    }
}

function Copy-PluginTree([string]$Source, [string]$Destination, [string]$Label) {
    if (Test-FileSystemEntry $Destination) {
        Fail "$Label destination is not fresh."
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        Fail "$Label copy failed."
    }
    if (@(Get-ChildItem -LiteralPath $Destination -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue).Count -ne 0) {
        Fail "$Label copy contains reparse indirection."
    }
}

function Remove-BuildInputs([string]$ProjectRoot, [string]$CorePluginRoot) {
    if (-not (Test-ContainedPath $ProjectRoot $CorePluginRoot)) {
        Fail "core plugin copy escaped the project."
    }
    foreach ($Name in @("Source", "Intermediate")) {
        $Path = Join-Path $CorePluginRoot $Name
        if (-not (Test-FileSystemEntry $Path)) {
            continue
        }
        $Item = Get-Item -LiteralPath $Path -Force
        if (-not $Item.PSIsContainer -or
            ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not (Test-ContainedPath $CorePluginRoot $Item.FullName)) {
            Fail "binary-only cleanup target is unsafe."
        }
        Remove-Item -LiteralPath $Item.FullName -Recurse -Force
        if (Test-FileSystemEntry $Item.FullName) {
            Fail "binary-only cleanup did not remove $Name."
        }
    }
}

function Write-HostProject([string]$ProjectRoot, $Target) {
    $ProjectPath = Join-Path $ProjectRoot "CleanHost.uproject"
    $Project = [ordered]@{
        FileVersion = 3
        EngineAssociation = [string]$Target.engineAssociation
        Category = "Validation"
        Description = "Unreal Editor WebUI clean-host acceptance"
        Plugins = @(
            [ordered]@{ Name = "UnrealEditorWebUI"; Enabled = $true },
            [ordered]@{ Name = "PythonScriptPlugin"; Enabled = $true },
            [ordered]@{ Name = "WebBrowserWidget"; Enabled = $true },
            [ordered]@{ Name = "AssetToolsFixture"; Enabled = $true },
            [ordered]@{ Name = "LevelToolsFixture"; Enabled = $true },
            [ordered]@{ Name = "ExampleAssetTools"; Enabled = $true }
        )
    }
    [System.IO.File]::WriteAllText(
        $ProjectPath,
        ($Project | ConvertTo-Json -Depth 8) + "`n",
        $StrictUtf8)
    return Resolve-RegularLeaf $ProjectPath "clean host project"
}

function ConvertTo-QuotedNativeArgument([string]$Value) {
    if ($Value.Contains('"') -or $Value.EndsWith("\", [System.StringComparison]::Ordinal)) {
        Fail "a native process argument is not safely representable."
    }
    return '"' + $Value + '"'
}

function Invoke-MatchingEditor(
    [string]$EditorCmd,
    [string]$ProjectPath,
    [string]$UserDir,
    [string]$LogPath,
    $Target
) {
    if ((Test-FileSystemEntry $UserDir) -or (Test-FileSystemEntry $LogPath)) {
        Fail "the matching editor output scope is not fresh."
    }
    $Documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    if ([string]::IsNullOrWhiteSpace($Documents) -or
        (Test-FileSystemEntry (Join-Path $Documents "UnrealEngine\Python\init_unreal.py"))) {
        Fail "the clean guest has an ambient Unreal Python startup script."
    }
    $env:UE_WEBUI_TOOL_PACK_TEST = "1"
    $env:PYTHONDONTWRITEBYTECODE = "1"
    Remove-Item Env:\PYTHONHOME -ErrorAction SilentlyContinue
    Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue

    $NativeArguments = @($ProjectPath)
    if ($Target.id -ceq "ue58") {
        $NativeArguments += "-ini:Engine:[ConsoleVariables]:Engine.Python.IsPythonInRestrictiveMode=1"
    }
    $NativeArguments += @(
        "-SKIPCOMPILE",
        "-ExecCmds=Automation RunTests UnrealEditorWebUI.Bridge.PackagedRegistryPing+UnrealEditorWebUI.Bridge.ThirdPartyToolPacks; Quit",
        "-unattended",
        "-nopause",
        "-nosplash",
        "-NullRHI",
        "-UserDir=$UserDir",
        "-abslog=$LogPath"
    )
    $ProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
    $ProcessInfo.FileName = $EditorCmd
    $ProcessInfo.Arguments = (@($NativeArguments | ForEach-Object {
        ConvertTo-QuotedNativeArgument ([string]$_)
    }) -join " ")
    $ProcessInfo.UseShellExecute = $false
    $ProcessInfo.CreateNoWindow = $true
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $ProcessInfo
    try {
        if (-not $Process.Start()) {
            Fail "the matching editor process did not start."
        }
        if (-not $Process.WaitForExit(45 * 60 * 1000)) {
            try {
                $Process.Kill()
                $Process.WaitForExit()
            }
            catch {
                Fail "the timed-out matching editor could not be terminated."
            }
            Fail "the matching editor exceeded its bounded runtime."
        }
        $EditorExitCode = $Process.ExitCode
    }
    finally {
        $Process.Dispose()
        Remove-Item Env:\UE_WEBUI_TOOL_PACK_TEST -ErrorAction SilentlyContinue
        Remove-Item Env:\PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
    }
    if ($EditorExitCode -ne 0) {
        Fail "the matching editor returned a nonzero exit code."
    }
    $ResolvedLog = Resolve-RegularLeaf $LogPath "matching editor log"
    $LogItem = Get-Item -LiteralPath $ResolvedLog -Force -ErrorAction Stop
    if ($LogItem.Length -gt $MaximumLogBytes) {
        Fail "the matching editor log exceeds the bounded size limit."
    }
    try {
        $LogText = [System.IO.File]::ReadAllText($ResolvedLog, $StrictUtf8)
    }
    catch {
        Fail "the matching editor log is not strict UTF-8 text."
    }
    $ExpectedTests = @(
        "UnrealEditorWebUI.Bridge.PackagedRegistryPing",
        "UnrealEditorWebUI.Bridge.ThirdPartyToolPacks"
    )
    foreach ($TestPath in $ExpectedTests) {
        $Pattern = "Test Completed\. Result=\{Success\}[^\r\n]*Path=\{$([regex]::Escape($TestPath))\}"
        if ([regex]::Matches($LogText, $Pattern).Count -ne 1) {
            Fail "a required clean-host automation test did not report one success."
        }
    }
    if ($LogText -match "Test Completed\. Result=\{(?!Success\})[^\r\n]*Path=\{UnrealEditorWebUI\.") {
        Fail "an Unreal Editor WebUI automation test reported a non-success result."
    }
    $CompilePattern = [string]::Join("|", @(
        "Running UnrealBuildTool",
        "UnrealBuildTool(?:\.exe|\.dll)",
        "dotnet(?:\.exe)?[^\r\n]*UnrealBuildTool\.dll",
        "Compiling UnrealEditorWebUI",
        "Building [0-9]+ action[^\r\n]*UnrealEditorWebUI",
        "Starting build\.\.\.",
        "Unable to load module[^\r\n]*UnrealEditorWebUI",
        "Missing or incompatible module[^\r\n]*UnrealEditorWebUI",
        "Incompatible or missing module[^\r\n]*UnrealEditorWebUI",
        "Plugin 'UnrealEditorWebUI' failed to load",
        "Plugin 'UnrealEditorWebUI' requires engine version",
        "Skipping load of 'UnrealEditorWebUI'",
        "Log(?:HotReload|LiveCoding)[^\r\n]*UnrealEditorWebUI"
    ))
    $RuntimeInstallPattern = [string]::Join("|", @(
        "UEPrereqSetup",
        "vc_redist",
        "Visual Studio Installer",
        "Installing (?:prerequisite|runtime)",
        "msiexec(?:\.exe)?",
        "winget(?:\.exe)?",
        "choco(?:\.exe)?",
        "(?:pip|npm) install"
    ))
    $CompileMarkersDetected = [regex]::IsMatch(
        $LogText,
        $CompilePattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $RuntimeInstallMarkersDetected = [regex]::IsMatch(
        $LogText,
        $RuntimeInstallPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($CompileMarkersDetected -or $RuntimeInstallMarkersDetected) {
        Fail "the matching editor log contains a prohibited build or installation marker."
    }
    return [ordered]@{
        editorExitCode = 0
        compileMarkersDetected = $false
        runtimeInstallMarkersDetected = $false
        logSha256 = Get-CanonicalSha256 $ResolvedLog
    }
}

function Write-JsonNoOverwrite([string]$Directory, [string]$FileName, $Value) {
    $Destination = Join-Path $Directory $FileName
    if (Test-FileSystemEntry $Destination) {
        Fail "an evidence output already exists."
    }
    $Temporary = Join-Path $Directory ("." + [guid]::NewGuid().ToString("N") + ".tmp")
    try {
        [System.IO.File]::WriteAllText(
            $Temporary,
            ($Value | ConvertTo-Json -Depth 20) + "`n",
            $StrictUtf8)
        [System.IO.File]::Move($Temporary, $Destination)
    }
    finally {
        if (Test-FileSystemEntry $Temporary) {
            Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-PrivateFailure {
    if (-not (Test-Path -LiteralPath $MappedEvidenceRoot -PathType Container)) {
        return
    }
    $FailurePath = Join-Path $MappedEvidenceRoot "guest-failure.json"
    $BindingPath = Join-Path $MappedEvidenceRoot "guest-binding.json"
    $ResultPath = Join-Path $MappedEvidenceRoot "guest-result.json"
    if ((Test-FileSystemEntry $FailurePath) -or (Test-FileSystemEntry $BindingPath)) {
        return
    }
    # A result is not complete evidence until the binding has been published.
    # If binding emission failed, remove only this fixed regular-file target so
    # the failure sentinel cannot be mistaken for a successful partial result.
    if (Test-FileSystemEntry $ResultPath) {
        try {
            $ResultItem = Get-Item -LiteralPath $ResultPath -Force -ErrorAction Stop
            if (-not $ResultItem.PSIsContainer -and
                ($ResultItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
                $ResultItem.FullName -ieq $ResultPath) {
                Remove-Item -LiteralPath $ResultPath -Force -ErrorAction Stop
            }
        }
        catch {
            # Still publish the failure sentinel; the controller rejects any
            # directory that does not contain exactly result + binding.
        }
    }
    $ReasonCode = "guest_internal_failed"
    if ($AllowedFailureStageCodes -ccontains $FailureStageCode) {
        $ReasonCode = $FailureStageCode
    }
    try {
        Write-JsonNoOverwrite $MappedEvidenceRoot "guest-failure.json" ([ordered]@{
            schemaVersion = 1
            result = "failure"
            reasonCode = $ReasonCode
        })
    }
    catch {
        return
    }
}

function Request-SandboxShutdown {
    if (-not $SandboxIdentityVerified) {
        return
    }
    $Shutdown = Join-Path $env:SystemRoot "System32\shutdown.exe"
    if (Test-Path -LiteralPath $Shutdown -PathType Leaf) {
        & $Shutdown /s /f /t 0 2>&1 | Out-Null
    }
}

try {
    if ($env:USERNAME -ine "WDAGUtilityAccount" -or
        -not (Test-Path -LiteralPath "C:\Users\WDAGUtilityAccount" -PathType Container)) {
        Fail "this entry point may run only inside the configured Windows Sandbox."
    }
    $SandboxIdentityVerified = $true

    $ResolvedEvidenceRoot = (Resolve-Path -LiteralPath $EvidenceRoot).Path
    if ($ResolvedEvidenceRoot -ine $MappedEvidenceRoot) {
        Fail "the evidence mapping is outside the fixed Sandbox path."
    }
    $EvidenceItem = Get-Item -LiteralPath $ResolvedEvidenceRoot -Force
    if (-not $EvidenceItem.PSIsContainer -or
        ($EvidenceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "the evidence root is not a regular mapped directory."
    }
    if (@(Get-ChildItem -LiteralPath $ResolvedEvidenceRoot -Force).Count -ne 0) {
        Fail "the evidence root is not fresh."
    }
    $SandboxVerified = $true

    $ResolvedInputRoot = (Resolve-Path -LiteralPath $InputRoot).Path
    $ResolvedEngineRoot = (Resolve-Path -LiteralPath $MappedEngineRoot).Path
    if ($ResolvedInputRoot -ine $InputRoot -or
        $ResolvedEngineRoot -ine $MappedEngineRoot) {
        Fail "a read-only Sandbox mapping is outside its fixed path."
    }
    try {
        $NativeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        Fail "the guest cannot prove its native operating-system architecture."
    }
    if (-not [Environment]::Is64BitOperatingSystem -or
        $NativeArchitecture -cne "X64" -or
        $env:PROCESSOR_ARCHITECTURE -cne "AMD64" -or
        $env:PROCESSOR_ARCHITEW6432 -ceq "ARM64") {
        Fail "the clean-host evidence requires a native x64 Windows Sandbox."
    }
    Assert-NetworkDisabled
    $ConsumerBaseline = Assert-ConsumerBaseline

    $FailureStageCode = "guest_plan_validation_failed"
    Assert-InputLayout

    $ResolvedGuestScript = Resolve-RegularLeaf $PSCommandPath "guest script"
    $ExpectedGuestScript = Join-Path $InputRoot "harness\run-clean-host-acceptance-guest.ps1"
    if ($ResolvedGuestScript -ine $ExpectedGuestScript) {
        Fail "the running guest script is outside the fixed harness path."
    }
    $ResolvedPlan = Resolve-RegularLeaf $Plan "guest plan"
    $ExpectedPlan = Join-Path $InputRoot ("plans\" + [System.IO.Path]::GetFileName($ResolvedPlan))
    if ($ResolvedPlan -ine $ExpectedPlan) {
        Fail "the guest plan is outside the fixed plan directory."
    }
    $PlanDocument = Read-StrictJson $ResolvedPlan "guest plan"
    $Target = Assert-Plan $PlanDocument
    if ([System.IO.Path]::GetFileName($ResolvedPlan) -cne "$($Target.id).json") {
        Fail "the guest plan filename does not match its target."
    }
    $Extractor = Resolve-InputFile "harness/extract-verified-artifact.py" "safe extractor"
    $PlanSha256 = Get-CanonicalSha256 $ResolvedPlan
    $GuestScriptSha256 = Get-CanonicalSha256 $ResolvedGuestScript
    $ExtractorSha256 = Get-CanonicalSha256 $Extractor
    Assert-ExactValue $GuestScriptSha256 $PlanDocument.harness.guestScript.sha256 "guest script hash"
    Assert-ExactValue $ExtractorSha256 $PlanDocument.harness.extractor.sha256 "safe extractor hash"
    $EnginePaths = Assert-EngineIdentity $Target

    $FailureStageCode = "guest_artifact_validation_failed"
    $WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) "uewebui-clean-$($PlanDocument.runId)-$($Target.id)"
    if (Test-FileSystemEntry $WorkRoot) {
        Fail "the guest work root is not fresh."
    }
    New-Item -ItemType Directory -Path $WorkRoot | Out-Null

    $CoreEvidence = @()
    $CorePluginRoots = [ordered]@{}
    $CorePlans = @($PlanDocument.coreArchives)
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $Variant = $Variants[$Index]
        $CorePlan = $CorePlans[$Index]
        $Archive = Resolve-InputFile ([string]$CorePlan.relativePath) "$($Variant.id) core archive"
        $Digest = Get-CanonicalSha256 $Archive
        Assert-ExactValue $Digest $CorePlan.sha256 "$($Variant.id) core archive hash"
        $Extraction = Join-Path $WorkRoot "inspect-core-$($Variant.id)"
        Invoke-SafeExtraction $EnginePaths.embeddedPython $Extractor $Archive $Extraction
        $PluginRoot = Resolve-OnlyPluginRoot $Extraction "UnrealEditorWebUI" "$($Variant.id) core"
        $Identity = Assert-CorePackage $CorePlan $Variant $PluginRoot
        $CorePluginRoots[$Variant.id] = $PluginRoot
        $CoreEvidence += [ordered]@{
            variantId = [string]$Variant.id
            subject = [string]$CorePlan.subject
            sha256 = $Digest
            descriptorVersion = [int]$Identity.descriptorVersion
            descriptorVersionName = [string]$Identity.descriptorVersionName
            descriptorEngineVersion = [string]$Identity.descriptorEngineVersion
            moduleBuildId = [string]$Identity.moduleBuildId
        }
    }

    # Close the two negative cells before the one permitted editor launch.  A
    # partial mismatch is input tampering, not acceptable compatibility evidence.
    $FailureStageCode = "guest_matrix_preflight_failed"
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $ArchiveVariant = $Variants[$Index]
        if ($ArchiveVariant.id -ceq $Target.id) {
            continue
        }
        $ArchiveIdentity = $CoreEvidence[$Index]
        if ([string]$ArchiveIdentity.descriptorEngineVersion -ceq "$($Target.engineAssociation).0" -or
            [string]$ArchiveIdentity.moduleBuildId -ceq [string]$Target.engine.buildId) {
            Fail "an off-diagonal archive did not prove both required identity mismatches before launch."
        }
    }

    $FailureStageCode = "guest_artifact_validation_failed"
    $ToolPackEvidence = @()
    $ToolPackRoots = [ordered]@{}
    $PackPlans = @($PlanDocument.toolPacks)
    for ($Index = 0; $Index -lt $ToolPackDefinitions.Count; $Index++) {
        $Definition = $ToolPackDefinitions[$Index]
        $PackPlan = $PackPlans[$Index]
        $Archive = Resolve-InputFile ([string]$PackPlan.relativePath) "$($Definition.id) archive"
        $Digest = Get-CanonicalSha256 $Archive
        Assert-ExactValue $Digest $PackPlan.sha256 "$($Definition.id) archive hash"
        $Extraction = Join-Path $WorkRoot "inspect-pack-$($Definition.id)"
        Invoke-SafeExtraction $EnginePaths.embeddedPython $Extractor $Archive $Extraction
        $PluginRoot = Resolve-OnlyPluginRoot $Extraction $Definition.id "$($Definition.id) Tool Pack"
        $ToolPackEvidence += Assert-ToolPackPackage $PackPlan $Definition $PluginRoot
        $ToolPackRoots[$Definition.id] = $PluginRoot
    }

    $FailureStageCode = "guest_editor_execution_failed"
    $ProjectRoot = Join-Path $WorkRoot "project"
    $PluginsRoot = Join-Path $ProjectRoot "Plugins"
    New-Item -ItemType Directory -Path $PluginsRoot | Out-Null
    $ProjectCore = Join-Path $PluginsRoot "UnrealEditorWebUI"
    Copy-PluginTree $CorePluginRoots[$Target.id] $ProjectCore "matching core"
    foreach ($Definition in $ToolPackDefinitions) {
        Copy-PluginTree $ToolPackRoots[$Definition.id] (Join-Path $PluginsRoot $Definition.id) "$($Definition.id) Tool Pack"
    }
    Remove-BuildInputs $ProjectRoot $ProjectCore
    foreach ($Required in @("Binaries\Win64\UnrealEditor-UnrealEditorWebUI.dll", "Web\dist\index.html", "Python")) {
        if (-not (Test-FileSystemEntry (Join-Path $ProjectCore $Required))) {
            Fail "the binary-only project is missing a required core payload."
        }
    }
    $ProjectPath = Write-HostProject $ProjectRoot $Target
    $UserDir = Join-Path $WorkRoot "user"
    $LogPath = Join-Path $WorkRoot "matching.log"
    $RunResult = Invoke-MatchingEditor $EnginePaths.editorCmd $ProjectPath $UserDir $LogPath $Target
    Assert-NetworkDisabled
    $PostRunConsumerBaseline = Assert-ConsumerBaseline
    foreach ($Name in @($ConsumerBaseline.Keys)) {
        Assert-ExactValue $PostRunConsumerBaseline[$Name] $ConsumerBaseline[$Name] "post-run consumer baseline.$Name"
    }

    $FailureStageCode = "guest_evidence_emission_failed"
    $AutomationResults = [ordered]@{
        "UnrealEditorWebUI.Bridge.PackagedRegistryPing" = "success"
        "UnrealEditorWebUI.Bridge.ThirdPartyToolPacks" = "success"
    }
    $CommandResults = [ordered]@{
        "system.ping" = "success"
        "system.toolPacks" = "success"
        "fixture.asset.echo" = "success"
        "fixture.level.echo" = "success"
    }
    $Matrix = @()
    for ($Index = 0; $Index -lt $Variants.Count; $Index++) {
        $ArchiveVariant = $Variants[$Index]
        $ArchiveIdentity = $CoreEvidence[$Index]
        if ($ArchiveVariant.id -ceq $Target.id) {
            $Matrix += [ordered]@{
                archiveVariantId = [string]$ArchiveVariant.id
                outcome = "success"
                editorLaunched = $true
                editorExitCode = [int]$RunResult.editorExitCode
                compileMarkersDetected = [bool]$RunResult.compileMarkersDetected
                runtimeInstallMarkersDetected = [bool]$RunResult.runtimeInstallMarkersDetected
                automationTests = $AutomationResults
                commandResults = $CommandResults
                logSha256 = [string]$RunResult.logSha256
            }
            continue
        }
        $EngineVersion = "$($Target.engineAssociation).0"
        $EngineBuildId = [string]$Target.engine.buildId
        if ([string]$ArchiveIdentity.descriptorEngineVersion -ceq $EngineVersion -or
            [string]$ArchiveIdentity.moduleBuildId -ceq $EngineBuildId) {
            Fail "an off-diagonal archive did not prove both required identity mismatches."
        }
        $Matrix += [ordered]@{
            archiveVariantId = [string]$ArchiveVariant.id
            outcome = "prelaunch-rejected"
            editorLaunched = $false
            rejectionReason = "descriptor-and-build-id-mismatch"
            descriptorEngineVersion = [ordered]@{
                engineValue = $EngineVersion
                archiveValue = [string]$ArchiveIdentity.descriptorEngineVersion
            }
            moduleBuildId = [ordered]@{
                engineValue = $EngineBuildId
                archiveValue = [string]$ArchiveIdentity.moduleBuildId
            }
        }
    }

    $OsVersion = [Environment]::OSVersion.Version
    if (-not [Environment]::Is64BitOperatingSystem -or
        $OsVersion.Major -ne 10 -or $OsVersion.Minor -ne 0 -or $OsVersion.Build -lt 1000) {
        Fail "the Windows Sandbox OS identity is unsupported."
    }
    $Evidence = [ordered]@{
        schemaVersion = 1
        result = "success"
        release = [ordered]@{
            tag = $ReleaseTag
            commit = [string]$PlanDocument.release.commit
            sourceKind = [string]$PlanDocument.sourceKind
        }
        guest = [ordered]@{
            os = [ordered]@{
                platform = "win32"
                version = $OsVersion.ToString()
                buildNumber = [int]$OsVersion.Build
                architecture = "x64"
                windowsSandbox = $true
            }
            consumerBaseline = $ConsumerBaseline
            engine = [ordered]@{
                variantId = [string]$Target.id
                majorVersion = [int]$Target.engine.majorVersion
                minorVersion = [int]$Target.engine.minorVersion
                patchVersion = [int]$Target.engine.patchVersion
                changelist = [int]$Target.engine.changelist
                compatibleChangelist = [int]$Target.engine.compatibleChangelist
                branchName = [string]$Target.engine.branchName
                buildId = [string]$Target.engine.buildId
            }
        }
        inputs = [ordered]@{
            coreArchives = $CoreEvidence
            toolPacks = $ToolPackEvidence
        }
        matrix = $Matrix
    }
    Write-JsonNoOverwrite $ResolvedEvidenceRoot "guest-result.json" $Evidence
    $ResultPath = Resolve-RegularLeaf (
        Join-Path $ResolvedEvidenceRoot "guest-result.json") "guest result"
    $Binding = [ordered]@{
        schemaVersion = 1
        runId = [string]$PlanDocument.runId
        variantId = [string]$Target.id
        planSha256 = $PlanSha256
        resultSha256 = Get-CanonicalSha256 $ResultPath
        guestScriptSha256 = $GuestScriptSha256
        extractorSha256 = $ExtractorSha256
    }
    Write-JsonNoOverwrite $ResolvedEvidenceRoot "guest-binding.json" $Binding
    $SuccessWritten = $true
    $ExitCode = 0
}
catch {
    if ($SandboxVerified -and -not $SuccessWritten) {
        Write-PrivateFailure
    }
    $ExitCode = 1
}
finally {
    Request-SandboxShutdown
}

exit $ExitCode
