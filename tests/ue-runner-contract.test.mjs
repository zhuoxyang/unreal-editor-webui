import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function assertOrdered(source, fragments) {
  let previous = -1
  for (const fragment of fragments) {
    const current = source.indexOf(fragment, previous + 1)
    assert.ok(current >= 0, `missing ordered fragment: ${fragment}`)
    previous = current
  }
}

const SETUP = read('scripts/setup-ue-runner.ps1')
const INVOKE = read('scripts/invoke-ue-runner-setup.ps1')
const START = read('scripts/start-ue-runner.ps1')
const FLEET = read('scripts/start-ue-runner-fleet.ps1')
const REGISTRATION_CLEANUP = read('scripts/remove-ue-runner-registration.ps1')
const CLEANUP = read('scripts/remove-ue-runner-wave.ps1')
const SESSION = read('scripts/test-interactive-runner-session.ps1')
const DIAGNOSTICS = read('scripts/write-ue-runner-diagnostics.ps1')
const PACKAGE = read('scripts/package-plugin.ps1')
const DOC = read('docs/ue-ci-runner.md')
const WORKFLOW = parse(read('.github/workflows/ue-ci.yml'))
const WORKFLOW_TEXT = read('.github/workflows/ue-ci.yml')

test('runner and bootstrap Node archives are immutable reviewed inputs', () => {
  assert.match(SETUP, /\$RunnerVersion = "2\.337\.0"/u)
  assert.match(
    SETUP,
    /\$RunnerSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"/u,
  )
  assert.match(SETUP, /\$NodeVersion = "24\.18\.1"/u)
  assert.match(
    SETUP,
    /\$NodeSha256 = "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765"/u,
  )
  const parameterBlock = SETUP.slice(0, SETUP.indexOf('Set-StrictMode'))
  for (const forbidden of ['RunnerVersion', 'RunnerSha256', 'NodeVersion', 'NodeSha256']) {
    assert.doesNotMatch(parameterBlock, new RegExp(`\\$${forbidden}\\b`, 'u'))
  }
  assert.doesNotMatch(SETUP, /Get-Command node|& node\b/iu)
  assert.match(SETUP, /https:\/\/nodejs\.org\/dist\/v\$NodeVersion/u)
  assert.match(SETUP, /https:\/\/github\.com\/actions\/runner\/releases\/download\/v\$RunnerVersion/u)
  assert.equal((SETUP.match(/Get-FileHash[^\n]+Algorithm SHA256/gu) || []).length, 2)
})

test('every registration is an exact-label, no-update, one-job listener', () => {
  for (const flag of ['--no-default-labels', '--disableupdate', '--ephemeral']) {
    assert.equal((SETUP.match(new RegExp(flag, 'gu')) || []).length, 1)
  }
  assert.match(SETUP, /\$Labels = "self-hosted,windows,gui,\$\(\$VariantEntry\.runner_label\)"/u)
  assert.match(SETUP, /\[ValidateSet\("build", "rez"\)\]/u)
  assert.match(SETUP, /\$RunnerRoot = Join-Path \$RunnerBase "\$Wave-\$Variant"/u)
  assert.match(SETUP, /\$RunnerName = "unreal-editor-webui-\$Wave-\$Variant"/u)
  assert.match(SETUP, /LOCALAPPDATA/u)
  assert.match(SETUP, /Runner profile ancestors must be real non-reparse directories/u)
  assert.match(START, /Runner profile ancestors must be real non-reparse directories/u)
  assert.match(FLEET, /Runner profile ancestors must be real non-reparse directories/u)
  assert.match(CLEANUP, /Runner profile ancestors must be real non-reparse directories/u)
  assert.doesNotMatch(SETUP, /--replace/u)
  assert.doesNotMatch(SETUP, /C:\\actions-runner/iu)
})

test('registration material stays out of the controller handoff and persisted evidence', () => {
  assert.doesNotMatch(INVOKE.slice(0, INVOKE.indexOf('Set-StrictMode')), /Token/iu)
  assert.doesNotMatch(INVOKE, /GITHUB_RUNNER_TOKEN|RegistrationToken|--token/iu)
  assert.match(INVOKE, /Start-Process[\s\S]*-Credential \$DedicatedUserCredential[\s\S]*-LoadUserProfile/u)
  assert.match(INVOKE, /Join-Path \$PSHOME "powershell\.exe"/u)
  assert.match(SETUP, /\[System\.Security\.SecureString\]\$RegistrationToken/u)
  assert.match(SETUP, /Read-Host "Short-lived GitHub runner registration token" -AsSecureString/u)
  assert.match(SETUP, /SecureStringToBSTR/u)
  assert.match(SETUP, /ZeroFreeBSTR/u)
  assert.doesNotMatch(SETUP, /GITHUB_RUNNER_TOKEN|Set-Content[^\n]*RegistrationToken/iu)
  const bootstrapStart = SETUP.indexOf('$BootstrapIdentity =')
  const bootstrap = SETUP.slice(bootstrapStart, SETUP.indexOf('$NodeArchiveName', bootstrapStart))
  assert.ok(bootstrapStart >= 0)
  assert.doesNotMatch(bootstrap, /PlainRegistrationToken|RegistrationToken|--token/iu)
})

test('failed setup has fail-closed automatic and exact-registration recovery paths', () => {
  assertOrdered(SETUP, [
    '$RunnerRootCreated = $false',
    '$RegistrationAttempted = $false',
    'try {',
    'New-Item -ItemType Directory -Path $RunnerRootFullPath',
    '$RunnerRootCreated = $true',
    'state = "provisioning"',
    'Write-BootstrapIdentity -RootPath $RunnerRootFullPath -Identity $BootstrapIdentity',
    '$BootstrapIdentity.state = "registration-attempted"',
    'Write-BootstrapIdentity -RootPath $RunnerRootFullPath -Identity $BootstrapIdentity',
    '$RegistrationAttempted = $true',
    '& $ConfigPath @ConfigArguments',
    '$BootstrapIdentity.state = "configured"',
    'Write-BootstrapIdentity -RootPath $RunnerRootFullPath -Identity $BootstrapIdentity',
    'catch {',
    'if (-not $RegistrationAttempted)',
    'if ($RunnerRootCreated)',
    'foreach ($RollbackAncestor in @($LocalAppDataPath, $ControlledRoot, $RunnerBase))',
    'Assert-NoReparseTree -LiteralPath $RollbackRootPath',
    'Get-Process -Name "Runner.Listener", "Runner.Worker", "Runner.PluginHost"',
    'Remove-Item -LiteralPath $RollbackRootPath -Recurse -Force',
    'if (Test-Path -LiteralPath $RunnerRootFullPath)',
  ])
  assert.match(SETUP, /schemaVersion = 2/u)
  assert.match(SETUP, /\[System\.IO\.File\]::Replace/u)
  assert.match(SETUP, /Runner setup rollback refuses a tree containing a reparse point/u)
  assert.match(SETUP, /remove-ue-runner-registration\.ps1/u)

  assert.match(REGISTRATION_CLEANUP, /\[ValidateSet\("ue54", "ue55", "ue58"\)\]/u)
  assert.match(REGISTRATION_CLEANUP, /\[ValidateSet\("build", "rez"\)\]/u)
  assert.match(REGISTRATION_CLEANUP, /\$GitHubRegistrationRemoved/u)
  assert.match(REGISTRATION_CLEANUP, /\$Bootstrap\.schemaVersion -ne 2/u)
  assert.match(REGISTRATION_CLEANUP, /"provisioning", "registration-attempted", "configured"/u)
  assertOrdered(REGISTRATION_CLEANUP, [
    'Assert-NoReparseTree -LiteralPath $TargetPath',
    '$BootstrapPath = Join-Path $TargetPath',
    'Get-Process -Name "Runner.Listener", "Runner.Worker", "Runner.PluginHost"',
    'Remove-Item -LiteralPath $TargetPath -Recurse -Force',
    'if (Test-Path -LiteralPath $TargetPath)',
  ])

  for (const source of [START, FLEET, CLEANUP]) {
    assert.match(source, /\$Bootstrap\.schemaVersion -ne 2/u)
    assert.match(source, /\[string\]\$Bootstrap\.state -cne "configured"/u)
  }
})

test('session probe proves a dedicated standard user on the active input desktop', () => {
  for (const fragment of [
    'LocalSystemSid',
    'LocalServiceSid',
    'NetworkServiceSid',
    'S-1-5-32-544',
    '[Environment]::UserInteractive',
    'WTSGetActiveConsoleSessionId',
    'OpenInputDesktop',
    'CloseDesktop',
    'Get-Process -Name explorer',
    'SpecialFolder]::UserProfile',
  ]) assert.match(SESSION, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(SESSION, /\$CurrentSessionId -eq 0/u)
  assert.match(SESSION, /\[uint32\]\$CurrentSessionId -ne \$ActiveConsoleSessionId/u)
  assert.match(SETUP, /test-interactive-runner-session\.ps1/u)
  assert.match(START, /test-interactive-runner-session\.ps1/u)
  assert.match(START, /UEWebUIRunnerBootstrap\.json/u)
  assert.match(START, /runnerArchiveSha256/u)
  assert.match(START, /nodeArchiveSha256/u)
  assert.match(FLEET, /test-interactive-runner-session\.ps1/u)

  const nativeJob = WORKFLOW.jobs['buildplugin-and-automation']
  const rezJob = WORKFLOW.jobs['rez-external-e2e']
  assert.match(
    nativeJob.steps.find(({ name }) => name === 'Validate runner prerequisites').run,
    /test-interactive-runner-session\.ps1/u,
  )
  assert.match(
    rezJob.steps.find(({ name }) => name === 'Validate external-path runner session').run,
    /test-interactive-runner-session\.ps1/u,
  )
})

test('whole workflow concurrency preserves matrix siblings and serializes trusted runs', () => {
  assert.deepEqual(WORKFLOW.concurrency, {
    group: 'ue-ci-protected-interactive',
    'cancel-in-progress': false,
  })
  assert.equal(WORKFLOW.jobs['buildplugin-and-automation'].concurrency, undefined)
  assert.equal(WORKFLOW.jobs['rez-external-e2e'].concurrency, undefined)
  assert.equal(WORKFLOW.jobs['buildplugin-and-automation'].strategy['max-parallel'], 1)
  assert.equal(WORKFLOW.jobs['rez-external-e2e'].strategy['max-parallel'], 1)
  for (const jobName of ['buildplugin-and-automation', 'rez-external-e2e']) {
    assert.match(WORKFLOW.jobs[jobName].if, /workflow_dispatch.*github\.ref == 'refs\/heads\/main'/u)
  }
})

test('fleet launcher exposes two explicit three-listener waves with bounded shutdown', () => {
  assert.match(FLEET, /\[ValidateSet\("build", "rez"\)\]/u)
  assert.match(FLEET, /foreach \(\$Variant in @\("ue54", "ue55", "ue58"\)\)/u)
  assert.match(FLEET, /\$Launches\.Count -ne 3/u)
  assert.doesNotMatch(FLEET, /foreach \(\$Wave in/u)
  assert.match(FLEET, /-WindowStyle Hidden/u)
  assert.match(FLEET, /taskkill\.exe/u)
  assert.match(FLEET, /\/PID \$Process\.Id \/T \/F/u)
  assert.match(FLEET, /WaitForExit\(5000\)/u)
  assert.match(CLEANUP, /Runner\.Listener", "Runner\.Worker", "Runner\.PluginHost/u)
  assert.match(CLEANUP, /\$GitHubRegistrationsRemoved/u)
  assert.match(CLEANUP, /Runner cleanup refuses a tree containing a reparse point/u)
  assert.ok(
    CLEANUP.indexOf('Assert-NoReparseTree -LiteralPath $TargetPath') <
      CLEANUP.indexOf('$BootstrapPath = Join-Path $TargetPath'),
  )
  assert.ok(CLEANUP.indexOf('$BootstrapPath = Join-Path $TargetPath') < CLEANUP.indexOf('Remove-Item -LiteralPath $Target'))
  assert.match(DOC, /one wave is launched at a time/iu)
  assert.match(DOC, /Do not start Rez listeners if any build job fails/iu)
})

test('diagnostic artifacts contain one allowlisted JSON and never raw logs', () => {
  const job = WORKFLOW.jobs['buildplugin-and-automation']
  const create = job.steps.find(({ name }) => name === 'Create allowlisted UE runner diagnostics')
  const upload = job.steps.find(({ name }) => name === 'Upload allowlisted UE runner diagnostics')
  assert.ok(create)
  assert.ok(upload)
  assert.equal(
    upload.with.path,
    '${{ runner.temp }}/UnrealEditorWebUI-RunnerDiagnostics-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}/RunnerDiagnostics.json',
  )
  assert.doesNotMatch(upload.with.path, /\.log|\*\*|Saved\/Logs|AutomationTool/iu)
  assert.doesNotMatch(WORKFLOW_TEXT, /name: Upload UE logs/u)
  for (const field of [
    'allowlistedFieldsOnly',
    'rawLogsUploaded',
    'environmentDumpUploaded',
    'registrationMaterialUploaded',
    'machinePathsUploaded',
    'userIdentityUploaded',
  ]) assert.match(DIAGNOSTICS, new RegExp(`${field}\\s*=`, 'u'))
  assert.doesNotMatch(DIAGNOSTICS, /Get-Content[^\n]*(?:\.log|AutomationTool|BrowserAutomation)/iu)
  assert.match(DIAGNOSTICS, /\$ExpectedReleaseVariants\[\$Variant\] -cne \$ReleaseVariant/u)
  const protectedLaunchLines = WORKFLOW_TEXT.split(/\r?\n/u).filter((line) =>
    line.includes('& $Editor') || line.includes('& $EmbeddedPython $Launcher launch'),
  )
  assert.equal(protectedLaunchLines.length, 6)
  for (const line of protectedLaunchLines) assert.match(line, /2>&1 \| Out-Null/u)
  assert.match(
    WORKFLOW_TEXT,
    /Tee-Object -FilePath \$env:UE_BUILDPLUGIN_CONSOLE_LOG \| Out-Null/u,
  )

  const nativeJob = WORKFLOW.jobs['buildplugin-and-automation']
  for (const [stepName, exitVariable] of [
    ['Run UE automation tests', 'AutomationExitCode'],
    ['Run packaged bridge smoke', 'SmokeExitCode'],
    ['Run native settings smoke', 'SettingsExitCode'],
    ['Run GUI CEF binding and task event test', 'EditorExitCode'],
  ]) {
    const source = nativeJob.steps.find(({ name }) => name === stepName).run
    assertOrdered(source, [
      `$${exitVariable} = -1`,
      '$PreviousErrorActionPreference = $ErrorActionPreference',
      '$ErrorActionPreference = "Continue"',
      '2>&1 | Out-Null',
      `$${exitVariable} = $LASTEXITCODE`,
      'finally {',
      '$ErrorActionPreference = $PreviousErrorActionPreference',
      `if ($${exitVariable} -ne 0)`,
    ])
    assert.match(
      source,
      new RegExp(`2>&1 \\| Out-Null\\n\\s+\\$${exitVariable} = \\$LASTEXITCODE`, 'u'),
    )
  }

  const rezSource = WORKFLOW.jobs['rez-external-e2e'].steps.find(
    ({ name }) => name === 'Run two-process external-path activation smoke',
  ).run
  for (const exitVariable of ['RoundOneExitCode', 'RoundTwoExitCode']) {
    const start = rezSource.indexOf(`$${exitVariable} = -1`)
    assert.ok(start >= 0)
    const source = rezSource.slice(start)
    assertOrdered(source, [
      `$${exitVariable} = -1`,
      '$PreviousErrorActionPreference = $ErrorActionPreference',
      '$ErrorActionPreference = "Continue"',
      '2>&1 | Out-Null',
      `$${exitVariable} = $LASTEXITCODE`,
      'finally {',
      '$ErrorActionPreference = $PreviousErrorActionPreference',
      `if ($${exitVariable} -ne 0)`,
    ])
    assert.match(
      source,
      new RegExp(`2>&1 \\| Out-Null\\n\\s+\\$${exitVariable} = \\$LASTEXITCODE`, 'u'),
    )
  }
})

test('UE 5.4 Houdini workaround is one exact, read-only, fail-closed argument', () => {
  const expectedHash = '44E6A8335FE84D80FADDC5D11D3BA3107C4DABBD044763BA42913E478AB7B1C4'
  const argument = '-Architecture_Win64=x64 -DisablePlugin=HoudiniEngine'
  assert.match(PACKAGE, new RegExp(expectedHash, 'u'))
  assert.equal((PACKAGE.match(new RegExp(argument, 'gu')) || []).length, 1)
  assert.match(PACKAGE, /MajorVersion -eq 5 -and \[int\]\$EngineBuildVersion\.MinorVersion -eq 4/u)
  for (const identity of ['PatchVersion = 4', 'Changelist = 35576357', 'CompatibleChangelist = 33043543']) {
    assert.match(PACKAGE, new RegExp(identity, 'u'))
  }
  const argsIndex = PACKAGE.indexOf('$RunUATArguments = @(')
  assert.ok(argsIndex >= 0)
  const argsSource = PACKAGE.slice(argsIndex, PACKAGE.indexOf('$RunUATExitCode', argsIndex))
  assert.ok(argsSource.indexOf('"-Rocket"') < argsSource.indexOf('$RunUATArguments += $RunUATCompatibilityArguments'))
  assert.match(PACKAGE, /\$HoudiniDescriptorSha256Before = Get-Sha256Hex/u)
  assert.match(PACKAGE, /Get-Sha256Hex -LiteralPath \$HoudiniDescriptorPath\) -cne \$HoudiniDescriptorSha256Before/u)
  assert.doesNotMatch(PACKAGE, /(?:Remove|Set|Move|Copy)-Item[^\n]*\$HoudiniDescriptorPath/iu)
  const parameterBlock = PACKAGE.slice(0, PACKAGE.indexOf('Set-StrictMode'))
  assert.doesNotMatch(parameterBlock, /UATArguments|Compatibility|Houdini/iu)
})
