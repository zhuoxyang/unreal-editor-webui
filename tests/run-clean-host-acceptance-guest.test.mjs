import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_AUTOMATION_TESTS,
  EXPECTED_COMMAND_RESULTS,
  EXPECTED_CONSUMER_BASELINE_FIELDS,
  EXPECTED_TOOL_PACKS,
} from '../scripts/validate-clean-host-evidence.mjs'
import { RELEASE_VARIANTS } from '../scripts/ue-release-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = readFileSync(
  resolve(ROOT, 'scripts/run-clean-host-acceptance-guest.ps1'),
  'utf8',
)

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('guest is fixed to the network-disabled Sandbox mappings and closed plan', () => {
  assert.match(SCRIPT, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$Plan/u)
  assert.match(SCRIPT, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$EvidenceRoot/u)
  assert.match(SCRIPT, /\$InputRoot = "C:\\UEWebUI\\Input"/u)
  assert.match(SCRIPT, /\$MappedEngineRoot = "C:\\UEWebUI\\Engine"/u)
  assert.match(SCRIPT, /\$MappedEvidenceRoot = "C:\\UEWebUI\\Evidence"/u)
  assert.match(SCRIPT, /Assert-NetworkDisabled/u)
  assert.match(SCRIPT, /Get-NetRoute -ErrorAction Stop/u)
  assert.doesNotMatch(
    SCRIPT,
    /DestinationPrefix[^\r\n]*NextHop|NextHop[^\r\n]*DestinationPrefix/u,
  )
  assert.match(SCRIPT, /the guest has an active default network route/u)
  assert.match(SCRIPT, /\$env:USERNAME -ine "WDAGUtilityAccount"/u)
  assert.match(SCRIPT, /\$SandboxIdentityVerified = \$true/u)
  assert.match(SCRIPT, /Assert-ExactKeys \$PlanDocument/u)
  assert.match(SCRIPT, /sourceKind/u)
  assert.match(SCRIPT, /Assert-ExactKeys \$PlanDocument\.harness @\("guestScript", "extractor"\)/u)
  assert.match(SCRIPT, /subject = "run-clean-host-acceptance-guest\.ps1"/u)
  assert.match(SCRIPT, /relativePath = "harness\/run-clean-host-acceptance-guest\.ps1"/u)
  assert.match(SCRIPT, /subject = "extract-verified-artifact\.py"/u)
  assert.match(SCRIPT, /relativePath = "harness\/extract-verified-artifact\.py"/u)
  const guestHashCheck = SCRIPT.indexOf(
    'Assert-ExactValue $GuestScriptSha256 $PlanDocument.harness.guestScript.sha256',
  )
  const extractorHashCheck = SCRIPT.indexOf(
    'Assert-ExactValue $ExtractorSha256 $PlanDocument.harness.extractor.sha256',
  )
  const editorLaunch = SCRIPT.indexOf('$RunResult = Invoke-MatchingEditor')
  assert.ok(guestHashCheck >= 0 && extractorHashCheck > guestHashCheck)
  assert.ok(editorLaunch > extractorHashCheck)

  for (const variant of RELEASE_VARIANTS) {
    assert.match(SCRIPT, new RegExp(`id = "${escaped(variant.id)}"`, 'u'))
    assert.match(
      SCRIPT,
      new RegExp(
        escaped(`UnrealEditorWebUI-v0.3.0-${variant.releaseVariant}.zip`),
        'u',
      ),
    )
    for (const key of [
      'majorVersion',
      'minorVersion',
      'patchVersion',
      'changelist',
      'compatibleChangelist',
    ]) {
      assert.match(SCRIPT, new RegExp(`${key} = ${variant.engine[key]}\\b`, 'u'))
    }
    assert.match(
      SCRIPT,
      new RegExp(`branchName = "${escaped(variant.engine.branchName)}"`, 'u'),
    )
    assert.match(SCRIPT, new RegExp(`buildId = "${escaped(variant.engine.buildId)}"`, 'u'))
  }
})

test('guest rejects ambiguous JSON and scalar type coercion before parsing inputs', () => {
  const jsonLengthGate = SCRIPT.indexOf(
    'if ($JsonItem.Length -gt $MaximumJsonBytes)',
  )
  const jsonRead = SCRIPT.indexOf(
    '[System.IO.File]::ReadAllText($ResolvedJson, $StrictUtf8)',
  )
  const logLengthGate = SCRIPT.indexOf(
    'if ($LogItem.Length -gt $MaximumLogBytes)',
  )
  const logRead = SCRIPT.indexOf(
    '[System.IO.File]::ReadAllText($ResolvedLog, $StrictUtf8)',
  )
  assert.match(SCRIPT, /\$MaximumJsonBytes = 1MB/u)
  assert.match(SCRIPT, /\$MaximumLogBytes = 128MB/u)
  assert.match(SCRIPT, /\$MaximumJsonNestingDepth = 64/u)
  assert.match(SCRIPT, /\$StrictJsonNumberRegex = \[regex\]/u)
  assert.ok(jsonLengthGate >= 0 && jsonLengthGate < jsonRead)
  assert.ok(logLengthGate >= 0 && logLengthGate < logRead)
  assert.match(SCRIPT, /function Assert-NoDuplicateJsonKeys/u)
  assert.match(SCRIPT, /Assert-NoDuplicateJsonKeys \$Text \$Label/u)
  assert.match(SCRIPT, /JSON document must be an object/u)
  assert.match(SCRIPT, /\$Frame\.keys\.ContainsKey\(\$Key\)/u)
  assert.match(SCRIPT, /\$Actual\.GetType\(\) -ne \$Expected\.GetType\(\)/u)
  assert.match(SCRIPT, /-not \$Actual\.Equals\(\$Expected\)/u)
  assert.match(SCRIPT, /\$Path -notmatch '\^\[A-Za-z\]:\[\\\\\/\]'/u)
})

test(
  'PowerShell 5.1 JSON guard rejects nested duplicates and scalar type changes',
  { skip: process.platform !== 'win32' },
  () => {
    const start = SCRIPT.indexOf('function Fail')
    const end = SCRIPT.indexOf('function Assert-InputLayout')
    assert.ok(start >= 0 && end > start)
    const directory = mkdtempSync(join(tmpdir(), 'uewebui-guest-json-'))
    const harnessPath = join(directory, 'guard-test.ps1')
    const functions = SCRIPT.slice(start, end)
    const harness = `
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$MaximumJsonBytes = 1MB
$MaximumJsonNestingDepth = 64
$StrictJsonNumberRegex = [regex]'\\G-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
${functions}
$ValidPath = Join-Path $PSScriptRoot "valid.json"
$DuplicatePath = Join-Path $PSScriptRoot "duplicate.json"
$ArrayPath = Join-Path $PSScriptRoot "array.json"
[System.IO.File]::WriteAllText($ValidPath, '{"outer":{"value":4,"flag":true}}', $StrictUtf8)
[System.IO.File]::WriteAllText($DuplicatePath, '{"outer":{"value":4,"value":5}}', $StrictUtf8)
[System.IO.File]::WriteAllText($ArrayPath, '[{"outer":{"value":4}}]', $StrictUtf8)
$Document = Read-StrictJson $ValidPath "valid fixture"
Assert-ExactValue $Document.outer.value ([int]4) "valid integer"
Assert-ExactValue $Document.outer.flag $true "valid boolean"
try {
    Read-StrictJson $DuplicatePath "duplicate fixture" | Out-Null
    exit 21
}
catch {
}
foreach ($Malformed in @(
    '{"a":1,}',
    '{/*comment*/"a":1}',
    '{"a":NaN}',
    '{"a":01}'
)) {
    [System.IO.File]::WriteAllText($ArrayPath, $Malformed, $StrictUtf8)
    try {
        Read-StrictJson $ArrayPath "malformed fixture" | Out-Null
        exit 25
    }
    catch {
    }
}
try {
    Read-StrictJson $ArrayPath "array fixture" | Out-Null
    exit 24
}
catch {
}
try {
    Assert-ExactValue ([string]"4") ([int]4) "coerced scalar"
    exit 22
}
catch {
}
try {
    Assert-ExactValue $null ([int]4) "null scalar"
    exit 23
}
catch {
}
$Paths = [ordered]@{ first = "one"; second = "two" }
foreach ($Name in @($Paths.Keys)) {
    $Paths[$Name] = $Paths[$Name].ToUpperInvariant()
}
if ($Paths.first -cne "ONE" -or $Paths.second -cne "TWO") {
    exit 26
}
function Get-ResolvedCommands { return @() }
function Assert-SystemPythonAbsent { }
function Get-StandardVisualStudioRoots { return @() }
function Test-EnvironmentVariablePresent { return $false }
function Test-RegistryInstallationData { return $false }
function Get-WindowsKitRoots { return @() }
function Test-Path {
    param([string]$LiteralPath, $PathType, $ErrorAction)
    return $false
}
$Baseline = Assert-ConsumerBaseline
$ExpectedBaselineKeys = @(
    "nodeCommandAbsent",
    "npmCommandAbsent",
    "systemPythonRuntimeAbsent",
    "visualStudioInstallationAbsent",
    "msvcCompilerAbsent",
    "windowsSdkDevelopmentFilesAbsent"
)
if (($Baseline.Keys -join "|") -cne ($ExpectedBaselineKeys -join "|") -or
    @($Baseline.Values | Where-Object { $_ -ne $true }).Count -ne 0) {
    exit 27
}
exit 0
`
    writeFileSync(harnessPath, harness, 'utf8')
    try {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('guest proves the exact external consumer baseline without installing anything', () => {
  assert.match(SCRIPT, /Assert-ConsumerBaseline/u)
  assert.match(SCRIPT, /Assert-SystemPythonAbsent/u)
  assert.match(
    SCRIPT,
    /Get-AppxPackage -Name "PythonSoftwareFoundation\.Python\*" -ErrorAction Stop/u,
  )
  for (const name of EXPECTED_CONSUMER_BASELINE_FIELDS) {
    assert.match(SCRIPT, new RegExp(`\\b${escaped(name)}\\b`, 'u'))
  }
  assert.match(SCRIPT, /consumerBaseline = \$ConsumerBaseline/u)
  assert.match(SCRIPT, /RuntimeInformation\]::OSArchitecture/u)
  assert.match(SCRIPT, /\$NativeArchitecture -cne "X64"/u)
  assert.match(SCRIPT, /\$env:PROCESSOR_ARCHITECTURE -cne "AMD64"/u)
  assert.equal((SCRIPT.match(/Assert-NetworkDisabled/gu) || []).length, 3)
  assert.equal((SCRIPT.match(/Assert-ConsumerBaseline/gu) || []).length, 3)
  assert.match(SCRIPT, /\$PostRunConsumerBaseline = Assert-ConsumerBaseline/u)
  assert.doesNotMatch(SCRIPT, /\babsentTools\b/u)
  for (const marker of [
    'nmake.exe',
    'vswhere.exe',
    'VSINSTALLDIR',
    'VCINSTALLDIR',
    'VCToolsInstallDir',
    'C:\\ProgramData\\Microsoft\\VisualStudio\\Packages\\_Instances',
    'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\Setup',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\Setup',
    'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\SxS',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\SxS',
    'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots',
    'Windows Kits\\10',
    'Microsoft Visual C++ Build Tools',
    'Windows.h',
    'Kernel32.Lib',
    'rc.exe',
    'WindowsSdkDir',
    'WindowsSDKVersion',
  ]) {
    assert.match(SCRIPT, new RegExp(escaped(marker), 'u'))
  }
  assert.doesNotMatch(SCRIPT, /\bmsbuild(?:\.exe)?\b/iu)
  assert.doesNotMatch(
    SCRIPT,
    /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|System\.Net\.WebClient|curl(?:\.exe)?\s+https?:|winget(?:\.exe)?\s+install|choco(?:\.exe)?\s+install|(?:pip|npm)\s+install\s+-/iu,
  )
  assert.doesNotMatch(SCRIPT, /validate-rez-external-smoke|UE_ADDITIONAL_PLUGIN_PATHS/u)
  assert.match(SCRIPT, /UnrealBuildTool\(\?:\\\.exe\|\\\.dll\)/u)
  assert.match(SCRIPT, /dotnet\(\?:\\\.exe\)\?/u)
})

test('guest digest-verifies and safely extracts the exact core and Tool Pack archives', () => {
  assert.match(SCRIPT, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/u)
  assert.match(SCRIPT, /return "sha256:\$Digest"/u)
  assert.match(
    SCRIPT,
    /& \$EmbeddedPython \$Extractor --archive \$Archive --destination \$Destination --profile package/u,
  )
  assert.match(SCRIPT, /Resolve-OnlyPluginRoot/u)
  assert.match(SCRIPT, /ToolPackDistribution\.json/u)
  assert.match(SCRIPT, /unreal-editor-webui-tool-pack/u)
  assert.match(SCRIPT, /content-only Tool Pack contains a native build directory/u)
  for (const { id, subject } of EXPECTED_TOOL_PACKS) {
    assert.match(SCRIPT, new RegExp(`id = "${escaped(id)}"`, 'u'))
    assert.match(SCRIPT, new RegExp(escaped(subject), 'u'))
  }
})

test('engine identity resolves a snapshot of ordered path keys', () => {
  assert.match(SCRIPT, /foreach \(\$Name in @\(\$Paths\.Keys\)\)/u)
  assert.doesNotMatch(SCRIPT, /foreach \(\$Name in \$Paths\.Keys\)/u)
})

test('both off-diagonal identities are rejected before the only editor launch', () => {
  const preflight = SCRIPT.indexOf(
    'did not prove both required identity mismatches before launch',
  )
  const launch = SCRIPT.indexOf('$RunResult = Invoke-MatchingEditor')
  assert.ok(preflight >= 0)
  assert.ok(launch > preflight)
  assert.match(
    SCRIPT,
    /descriptorEngineVersion -ceq "\$\(\$Target\.engineAssociation\)\.0" -or/u,
  )
  assert.match(
    SCRIPT,
    /moduleBuildId -ceq \[string\]\$Target\.engine\.buildId/u,
  )
  assert.match(SCRIPT, /outcome = "prelaunch-rejected"/u)
  assert.match(SCRIPT, /editorLaunched = \$false/u)
  assert.match(SCRIPT, /rejectionReason = "descriptor-and-build-id-mismatch"/u)
})

test('matching archive uses a source-stripped Project Plugins host and exact automation pair', () => {
  assert.match(SCRIPT, /\$PluginsRoot = Join-Path \$ProjectRoot "Plugins"/u)
  assert.match(SCRIPT, /foreach \(\$Name in @\("Source", "Intermediate"\)\)/u)
  assert.match(SCRIPT, /-SKIPCOMPILE/u)
  assert.match(SCRIPT, /-NullRHI/u)
  assert.match(SCRIPT, /UE_WEBUI_TOOL_PACK_TEST/u)
  assert.match(
    SCRIPT,
    /-ExecCmds=Automation RunTests UnrealEditorWebUI\.Bridge\.PackagedRegistryPing\+UnrealEditorWebUI\.Bridge\.ThirdPartyToolPacks; Quit/u,
  )
  assert.match(
    SCRIPT,
    /-ini:Engine:\[ConsoleVariables\]:Engine\.Python\.IsPythonInRestrictiveMode=1/u,
  )
  for (const name of EXPECTED_AUTOMATION_TESTS) {
    assert.match(SCRIPT, new RegExp(escaped(name), 'u'))
  }
  for (const name of EXPECTED_COMMAND_RESULTS) {
    assert.match(SCRIPT, new RegExp(escaped(name), 'u'))
  }
  assert.match(SCRIPT, /Running UnrealBuildTool/u)
  assert.match(SCRIPT, /Compiling UnrealEditorWebUI/u)
  assert.match(SCRIPT, /UEPrereqSetup/u)
  assert.match(SCRIPT, /runtimeInstallMarkersDetected = \$false/u)
})

test('guest writes only closed privacy-safe evidence or a stable private failure', () => {
  const resultWrite = SCRIPT.indexOf(
    'Write-JsonNoOverwrite $ResolvedEvidenceRoot "guest-result.json" $Evidence',
  )
  const bindingWrite = SCRIPT.indexOf(
    'Write-JsonNoOverwrite $ResolvedEvidenceRoot "guest-binding.json" $Binding',
  )
  const successMark = SCRIPT.indexOf('$SuccessWritten = $true', bindingWrite)
  assert.ok(resultWrite >= 0 && bindingWrite > resultWrite)
  assert.ok(successMark > bindingWrite)
  assert.equal(
    (SCRIPT.match(/Write-JsonNoOverwrite \$ResolvedEvidenceRoot "guest-binding\.json"/gu) || [])
      .length,
    1,
  )
  const bindingBlock = SCRIPT.match(
    /\$Binding = \[ordered\]@\{([\s\S]*?)\r?\n    \}/u,
  )
  assert.ok(bindingBlock)
  assert.deepEqual(
    [...bindingBlock[1].matchAll(/^        ([A-Za-z][A-Za-z0-9]*) =/gmu)].map(
      (match) => match[1],
    ),
    [
      'schemaVersion',
      'runId',
      'variantId',
      'planSha256',
      'resultSha256',
      'guestScriptSha256',
      'extractorSha256',
    ],
  )
  assert.match(SCRIPT, /Resolve-RegularLeaf \$PSCommandPath "guest script"/u)
  assert.match(SCRIPT, /\$PlanSha256 = Get-CanonicalSha256 \$ResolvedPlan/u)
  assert.match(SCRIPT, /\$GuestScriptSha256 = Get-CanonicalSha256 \$ResolvedGuestScript/u)
  assert.match(SCRIPT, /\$ExtractorSha256 = Get-CanonicalSha256 \$Extractor/u)
  assert.match(SCRIPT, /\$BindingPath = Join-Path \$MappedEvidenceRoot "guest-binding\.json"/u)
  assert.match(SCRIPT, /A result is not complete evidence until the binding has been published/u)
  assert.match(SCRIPT, /Remove-Item -LiteralPath \$ResultPath -Force -ErrorAction Stop/u)
  assert.match(SCRIPT, /reasonCode = \$ReasonCode/u)
  for (const reasonCode of [
    'guest_environment_preflight_failed',
    'guest_plan_validation_failed',
    'guest_artifact_validation_failed',
    'guest_matrix_preflight_failed',
    'guest_editor_execution_failed',
    'guest_evidence_emission_failed',
    'guest_internal_failed',
  ]) {
    assert.match(SCRIPT, new RegExp(`"${reasonCode}"`, 'u'))
  }
  assert.match(SCRIPT, /logSha256 = Get-CanonicalSha256/u)
  assert.doesNotMatch(SCRIPT, /rawLog\s*=/u)
  assert.match(SCRIPT, /if \(-not \$SandboxIdentityVerified\)/u)
  assert.ok(
    SCRIPT.indexOf('$SandboxIdentityVerified = $true') <
      SCRIPT.indexOf('$ResolvedInputRoot = (Resolve-Path -LiteralPath $InputRoot).Path'),
  )
  assert.match(SCRIPT, /shutdown\.exe/u)
})
