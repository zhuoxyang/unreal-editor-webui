import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

import {
  CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
  CLEAN_HOST_PLUGIN_VERSION,
  CLEAN_HOST_PLUGIN_VERSION_NAME,
  CLEAN_HOST_RELEASE_TAG,
  EXPECTED_AUTOMATION_TESTS,
  EXPECTED_COMMAND_RESULTS,
  EXPECTED_CONSUMER_BASELINE_FIELDS,
  EXPECTED_TOOL_PACKS,
} from '../scripts/validate-clean-host-evidence.mjs'
import { RELEASE_VARIANTS } from '../scripts/ue-release-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function assertOrdered(source, fragments) {
  let previous = -1
  for (const fragment of fragments) {
    const current = source.indexOf(fragment, previous + 1)
    assert.ok(current >= 0, `missing ordered fragment: ${fragment}`)
    previous = current
  }
}

const HOST = read('scripts/invoke-clean-host-acceptance.ps1')
const GUEST = read('scripts/run-clean-host-acceptance-guest.ps1')
const VALIDATOR = read('scripts/validate-clean-host-evidence.mjs')
const CI = parse(read('.github/workflows/ci.yml'))
const UE_CI = parse(read('.github/workflows/ue-ci.yml'))

test(
  'Windows PowerShell 5.1 controller JSON reader rejects non-standard JSON',
  { skip: process.platform !== 'win32' },
  () => {
    const start = HOST.indexOf('function Fail')
    const end = HOST.indexOf('function Assert-ExactKeys')
    assert.ok(start >= 0 && end > start)
    const directory = mkdtempSync(join(tmpdir(), 'uewebui-host-json-'))
    const harnessPath = join(directory, 'controller-json-test.ps1')
    const functions = HOST.slice(start, end)
    const harness = `
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$MaximumControllerJsonBytes = 1MB
$MaximumControllerJsonNestingDepth = 64
$StrictControllerJsonNumberRegex = [regex]'\\G-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
${functions}
function Resolve-RealLocalPath([string]$Path, [string]$Label, [string]$Kind) {
    return (Resolve-Path -LiteralPath $Path).Path
}
$Fixture = Join-Path $PSScriptRoot "fixture.json"
[System.IO.File]::WriteAllText($Fixture, '{"outer":{"value":4,"flag":true}}', $StrictUtf8)
$Document = Read-JsonFile $Fixture "valid fixture"
if ($Document.outer.value.GetType() -ne [int] -or $Document.outer.flag -ne $true) { exit 31 }
foreach ($Malformed in @(
    '{"outer":{"value":4,"value":5}}',
    '{"a":1,}',
    '{/*comment*/"a":1}',
    '{"a":NaN}',
    '{"a":01}',
    '[{"a":1}]'
)) {
    [System.IO.File]::WriteAllText($Fixture, $Malformed, $StrictUtf8)
    try {
        Read-JsonFile $Fixture "malformed fixture" | Out-Null
        exit 32
    }
    catch {
    }
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

test(
  'Windows PowerShell 5.1 resolves regular files and walks their ancestor directories',
  { skip: process.platform !== 'win32' },
  () => {
    const start = HOST.indexOf('function Resolve-RealLocalPath')
    const end = HOST.indexOf('function Test-PathContains')
    assert.ok(start >= 0 && end > start)
    const directory = mkdtempSync(join(tmpdir(), 'uewebui-host-path-'))
    const fixture = join(directory, 'fixture.txt')
    const harnessPath = join(directory, 'path-test.ps1')
    writeFileSync(fixture, 'fixture', 'utf8')
    const harness = `
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
function Fail([string]$Message) { throw $Message }
${HOST.slice(start, end)}
$ResolvedDirectory = Resolve-RealLocalPath $PSScriptRoot "fixture directory" "Container"
$ResolvedFile = Resolve-RealLocalPath (Join-Path $PSScriptRoot "fixture.txt") "fixture file" "Leaf"
if ($ResolvedDirectory -ine $PSScriptRoot -or $ResolvedFile -ine (Join-Path $PSScriptRoot "fixture.txt")) {
    exit 41
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

test('controller binds the release to the closed engine and archive identities', () => {
  assert.equal(CLEAN_HOST_EVIDENCE_SCHEMA_VERSION, 1)
  assert.equal(CLEAN_HOST_PLUGIN_VERSION, 4)
  assert.equal(CLEAN_HOST_PLUGIN_VERSION_NAME, '0.3.0')
  assert.equal(CLEAN_HOST_RELEASE_TAG, 'v0.3.0')
  assert.deepEqual(RELEASE_VARIANTS.map(({ id }) => id), ['ue54', 'ue55', 'ue58'])

  assert.match(HOST, /\[ValidateSet\("candidate", "published", IgnoreCase = \$false\)\]/u)
  assert.match(HOST, /\$ReleaseTag = "v0\.3\.0"/u)
  assert.match(HOST, /\$ReleaseCommit -cnotmatch "\^\[0-9a-f\]\{40\}\$"/u)
  assert.match(HOST, /\(\$Ids -join ","\) -cne "ue54,ue55,ue58"/u)
  assert.match(HOST, /\$Provenance\.schemaVersion -ne 3/u)
  assert.match(HOST, /releaseCommit -cne \$Commit/u)
  assert.match(HOST, /releaseArchive\.sha256 -cne \$Digest/u)
  assert.match(HOST, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/u)
  assert.match(HOST, /\$MaximumControllerJsonBytes = 1MB/u)
  assert.match(HOST, /\$MaximumCoreArchiveBytes = 128MB/u)
  assert.match(HOST, /\$MaximumChecksumSidecarBytes = 512/u)
  assert.match(HOST, /must be one JSON object/u)
  assert.match(HOST, /Assert-StrictJsonGrammar \$Text \$Label/u)
  assert.match(HOST, /Assert-RepositorySnapshot \$ReleaseCommit/u)
  assert.match(HOST, /rev-parse --verify HEAD/u)
  assert.match(HOST, /status --porcelain=v1 --untracked-files=all/u)
  assert.match(HOST, /hash-object "--path=\$RelativePath"/u)
  assert.match(HOST, /archive --format=zip/u)
  assert.match(HOST, /source-snapshot\.zip/u)
  assert.match(HOST, /run-manifest\.json/u)
  assert.match(HOST, /guest-binding\.json/u)
  assert.match(HOST, /Assert-ExactKeys \$Failure @\("schemaVersion", "result", "reasonCode"\)/u)
  assert.match(HOST, /\$AllowedGuestFailureCodes -cnotcontains/u)
  assert.match(HOST, /\$Validator = \[string\]\$Context\.validator/u)
  assert.match(HOST, /ue-release-variants\.mjs/u)
  assert.match(HOST, /\$OutputText = \$OutputLines -join "`n"/u)
  assert.doesNotMatch(HOST, /\$OutputLines\.Count -ne 1/u)
  assert.match(HOST, /foreach \(\$Name in @\(\$Paths\.Keys\)\)/u)
  assert.match(HOST, /\$Candidates = @\(\s*@\(/u)
  assert.match(HOST, /if \(\$Candidates\.Count -ne 1\)/u)

  for (const { id } of RELEASE_VARIANTS) {
    assert.match(HOST, new RegExp(escaped(id), 'u'))
    assert.match(HOST, new RegExp(`UnrealEditorWebUI-\\$ReleaseTag-\\$\\(\\$Variant\\.releaseVariant\\)\\.zip`, 'u'))
  }
  assert.match(VALIDATOR, /RELEASE_VARIANTS/u)
  for (const { id } of EXPECTED_TOOL_PACKS) {
    assert.match(HOST, new RegExp(`id = "${escaped(id)}"`, 'u'))
  }
  assert.match(HOST, /"\$\(\$Definition\.id\)-1\.0\.0-ToolPack\.zip"/u)
})

test('controller emits a network-disabled Sandbox with only evidence writable', () => {
  for (const [setting, value] of [
    ['VGpu', 'Disable'],
    ['Networking', 'Disable'],
    ['AudioInput', 'Disable'],
    ['VideoInput', 'Disable'],
    ['PrinterRedirection', 'Disable'],
    ['ClipboardRedirection', 'Disable'],
    ['ProtectedClient', 'Enable'],
  ]) {
    assert.match(HOST, new RegExp(`@\\("${setting}", "${value}"\\)`, 'u'))
  }
  assert.match(HOST, /@\(\$InputRoot, "C:\\UEWebUI\\Input", "true"\)/u)
  assert.match(HOST, /@\(\$EngineRoot, "C:\\UEWebUI\\Engine", "true"\)/u)
  assert.match(HOST, /@\(\$EvidenceRoot, "C:\\UEWebUI\\Evidence", "false"\)/u)
  assert.match(HOST, /Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint/u)

  assertOrdered(HOST, [
    'Get-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM"',
    'if ([string]$Feature.State -cne "Enabled")',
    'Get-Command WindowsSandbox.exe',
    '$SandboxLaunchProcess = Start-Process',
  ])
  assert.match(HOST, /this script never enables Windows features/u)
  assert.match(HOST, /\$ObservedSandboxProcess = \$true/u)
  assert.match(HOST, /closed before writing a completion or failure sentinel/u)
  assert.doesNotMatch(
    HOST,
    /Enable-WindowsOptionalFeature|\/Enable-Feature|Invoke-WebRequest|Start-BitsTransfer|winget(?:\.exe)?|choco(?:\.exe)?|msiexec(?:\.exe)?/iu,
  )
})

test('guest proves the Sandbox, network, and consumer baseline before extraction', () => {
  assert.match(GUEST, /\$env:USERNAME -ine "WDAGUtilityAccount"/u)
  assert.match(GUEST, /C:\\Users\\WDAGUtilityAccount/u)
  assert.match(GUEST, /DestinationPrefix -eq "0\.0\.0\.0\/0"/u)
  assert.match(GUEST, /DestinationPrefix -eq "::\/0"/u)
  assert.match(GUEST, /the guest has an active default network route/u)
  assert.match(GUEST, /Get-Command \$Name -All -ErrorAction SilentlyContinue/u)
  assert.match(GUEST, /Assert-ConsumerBaseline/u)
  assert.match(GUEST, /SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots/u)
  assert.match(GUEST, /SOFTWARE\\Microsoft\\VisualStudio\\Setup/u)
  assert.match(GUEST, /an evidence output already exists/u)
  assert.match(GUEST, /\[System\.IO\.File\]::Move\(\$Temporary, \$Destination\)/u)
  assertOrdered(GUEST, [
    '$env:USERNAME -ine "WDAGUtilityAccount"',
    '$SandboxVerified = $true',
    'Assert-NetworkDisabled',
    '$ConsumerBaseline = Assert-ConsumerBaseline',
    'Assert-InputLayout',
    '$ResolvedPlan = Resolve-RegularLeaf $Plan "guest plan"',
    'Invoke-MatchingEditor $EnginePaths.editorCmd $ProjectPath $UserDir $LogPath $Target',
    'Write-JsonNoOverwrite $ResolvedEvidenceRoot "guest-result.json" $Evidence',
  ])
})

test('guest launches only the matching binary and rejects every off-diagonal archive', () => {
  assert.match(GUEST, /UnrealEditor-Cmd\.exe/u)
  assert.match(GUEST, /-SKIPCOMPILE/u)
  assert.match(GUEST, /UE_WEBUI_TOOL_PACK_TEST/u)
  assert.match(GUEST, /Source/u)
  assert.match(GUEST, /Intermediate/u)
  assert.match(GUEST, /descriptor-and-build-id-mismatch/u)
  assert.match(GUEST, /prelaunch-rejected/u)
  assert.match(GUEST, /editorLaunched/u)
  assert.match(GUEST, /compileMarkersDetected/u)
  assert.match(GUEST, /runtimeInstallMarkersDetected/u)
  assert.match(GUEST, /guest-result\.json/u)
  assert.match(GUEST, /guest-failure\.json/u)

  for (const name of EXPECTED_CONSUMER_BASELINE_FIELDS) {
    assert.match(GUEST, new RegExp(`\\b${escaped(name)}\\b`, 'u'))
  }
  for (const name of EXPECTED_AUTOMATION_TESTS) {
    assert.match(GUEST, new RegExp(escaped(name), 'u'))
  }
  for (const name of EXPECTED_COMMAND_RESULTS) {
    assert.match(GUEST, new RegExp(escaped(name), 'u'))
  }
  for (const { subject } of EXPECTED_TOOL_PACKS) {
    assert.match(GUEST, new RegExp(escaped(subject), 'u'))
  }

  assertOrdered(GUEST, [
    '# Close the two negative cells before the one permitted editor launch.',
    'if ([string]$ArchiveIdentity.descriptorEngineVersion -ceq "$($Target.engineAssociation).0" -or',
    '[string]$ArchiveIdentity.moduleBuildId -ceq [string]$Target.engine.buildId)',
    'Fail "an off-diagonal archive did not prove both required identity mismatches before launch."',
    'Copy-PluginTree $CorePluginRoots[$Target.id] $ProjectCore "matching core"',
    'Invoke-MatchingEditor $EnginePaths.editorCmd $ProjectPath $UserDir $LogPath $Target',
    'outcome = "prelaunch-rejected"',
    'editorLaunched = $false',
    'rejectionReason = "descriptor-and-build-id-mismatch"',
  ])
  assert.equal(
    (GUEST.match(/Invoke-MatchingEditor \$EnginePaths\.editorCmd/gu) || []).length,
    1,
  )
  assert.doesNotMatch(
    GUEST,
    /Invoke-WebRequest|Start-BitsTransfer|Enable-WindowsOptionalFeature|(?:^|\n)\s*(?:&|Start-Process\b)[^\r\n]*(?:winget|choco|msiexec|UEPrereqSetup|vc_redist|pip(?:\.exe)?\s+install|npm(?:\.cmd|\.exe)?\s+install)/iu,
  )
})

test('guest emission and validator share one strict allowlisted evidence shape', () => {
  for (const field of [
    'schemaVersion',
    'result',
    'release',
    'guest',
    'consumerBaseline',
    'inputs',
    'matrix',
    'archiveVariantId',
    'outcome',
    'editorLaunched',
    'editorExitCode',
    'compileMarkersDetected',
    'runtimeInstallMarkersDetected',
    'automationTests',
    'commandResults',
    'logSha256',
    'rejectionReason',
    'descriptorEngineVersion',
    'moduleBuildId',
  ]) {
    assert.match(GUEST, new RegExp(`\\b${field}\\b`, 'u'))
    assert.match(VALIDATOR, new RegExp(`['"]${field}['"]`, 'u'))
  }
  assert.match(VALIDATOR, /exactKeys\(/u)
  assert.match(VALIDATOR, /duplicate object fields/u)
  assert.match(VALIDATOR, /prohibited path, control, log, or secret text/u)
  assert.match(VALIDATOR, /must be fresh and must not already exist/u)
  assert.match(VALIDATOR, /paths must not traverse reparse indirection/u)
  assert.match(VALIDATOR, /exactly three successes and six rejections/u)
  assert.doesNotMatch(VALIDATOR, /absentTools|EXPECTED_ABSENT_TOOLS/u)
})

test('both workflows parse the scripts and run the static evidence contracts', () => {
  const expectedScripts = [
    'scripts/invoke-clean-host-acceptance.ps1',
    'scripts/run-clean-host-acceptance-guest.ps1',
  ]
  const expectedNodeCommands = [
    'node --check scripts/validate-clean-host-evidence.mjs',
    'node --test tests/validate-clean-host-evidence.test.mjs',
    'node --test tests/run-clean-host-acceptance-guest.test.mjs',
    'node --test tests/clean-host-acceptance-contract.test.mjs',
  ]

  const ciParser = CI.jobs.repository.steps.find(
    ({ name }) => name === 'Check PowerShell script syntax',
  )?.run
  const ueParser = UE_CI.jobs['ue-config-validation'].steps.find(
    ({ name }) => name === 'Validate PowerShell scripts',
  )?.run
  for (const source of [ciParser, ueParser]) {
    assert.equal(typeof source, 'string')
    for (const script of expectedScripts) assert.match(source, new RegExp(escaped(script), 'u'))
  }

  const hostedCi = CI.jobs.repository.steps.find(
    ({ name }) => name === 'Check release helper syntax',
  )?.run
  const hostedUe = UE_CI.jobs['fast-checks'].steps.find(
    ({ name }) => name === 'Validate UE build-environment evidence tooling',
  )?.run
  const windows = CI.jobs['packaging-windows'].steps.find(
    ({ name }) => name === 'Test Windows packaging contracts',
  )?.run
  for (const source of [hostedCi, hostedUe, windows]) {
    assert.equal(typeof source, 'string')
    for (const command of expectedNodeCommands) {
      assert.match(source, new RegExp(escaped(command), 'u'))
    }
  }

  const windowsDependencyInstall = CI.jobs['packaging-windows'].steps.find(
    ({ name }) => name === 'Install repository test dependencies',
  )?.run
  assert.match(windowsDependencyInstall, /npm ci --ignore-scripts --include=dev/u)
  const windowsPowerShellParser = CI.jobs['packaging-windows'].steps.find(
    ({ name }) => name === 'Validate Windows PowerShell 5.1 scripts',
  )
  assert.equal(windowsPowerShellParser?.shell, 'powershell')
  assert.match(windowsPowerShellParser?.run, /Parser\]::ParseFile/u)
  assert.match(windows, /clean-host-acceptance-contract\.test\.mjs\s+if \(\$LASTEXITCODE -ne 0\)/u)
})
