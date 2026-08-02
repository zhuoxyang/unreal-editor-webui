import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parse } from 'yaml'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_PATH = join(REPOSITORY_ROOT, '.github', 'workflows', 'ue-ci.yml')
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8')
const WORKFLOW = parse(WORKFLOW_SOURCE)
const RELEASE_WORKFLOW = parse(
  readFileSync(
    join(REPOSITORY_ROOT, '.github', 'workflows', 'release-candidate.yml'),
    'utf8',
  ),
)
const JOB = WORKFLOW.jobs['buildplugin-and-automation']
const STEPS = JOB.steps
const AUTOMATION_TOOL_DIRECTORY_OUTPUT = '${{ steps.automation_tool_logs.outputs.directory }}'
const BUILDPLUGIN_CONSOLE_LOG_OUTPUT =
  '${{ steps.automation_tool_logs.outputs.console_log }}'
const RUN_SUFFIX_ASSIGNMENT =
  '$RunSuffix = "$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"'
const SCOPED_PACKAGE_ASSIGNMENT =
  '$PackageDir = Join-Path $env:RUNNER_TEMP "UnrealEditorWebUI-Package-$RunSuffix"'
const EXPECTED_PACKAGE_UPLOAD_PATH =
  '${{ runner.temp }}/UnrealEditorWebUI-Package-${{ github.run_id }}-${{ github.run_attempt }}'
const EXPECTED_LOG_PATHS = [
  '${{ runner.temp }}/UnrealEditorWebUI-Automation-${{ github.run_id }}-${{ github.run_attempt }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-PackagedBridgeSmoke-${{ github.run_id }}-${{ github.run_attempt }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-PackagedBridgeSmoke-${{ github.run_id }}-${{ github.run_attempt }}.json',
  '${{ runner.temp }}/UnrealEditorWebUI-SettingsSmoke-${{ github.run_id }}-${{ github.run_attempt }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-BrowserAutomation-${{ github.run_id }}-${{ github.run_attempt }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-BrowserAutomationReport-${{ github.run_id }}-${{ github.run_attempt }}/**',
  '${{ runner.temp }}/UnrealEditorWebUI-HostProject-${{ github.run_id }}-${{ github.run_attempt }}/Saved/Logs/**',
  BUILDPLUGIN_CONSOLE_LOG_OUTPUT,
  `${AUTOMATION_TOOL_DIRECTORY_OUTPUT}/**`,
]

function stepNamed(name) {
  const step = STEPS.find((candidate) => candidate.name === name)
  assert.ok(step, `missing workflow step: ${name}`)
  return step
}

function assertOrdered(source, fragments) {
  let previousIndex = -1
  for (const fragment of fragments) {
    const index = source.indexOf(fragment)
    assert.ok(index >= 0, `missing workflow command: ${fragment}`)
    assert.ok(index > previousIndex, `workflow command is out of order: ${fragment}`)
    previousIndex = index
  }
}

test('protected UE Node setup does not depend on the remote npm cache', () => {
  const nodeSetup = stepNamed('Set up Node.js')
  const hostedNodeSetup = WORKFLOW.jobs['fast-checks'].steps.find(
    (step) => step.name === 'Set up Node.js',
  )

  assert.ok(hostedNodeSetup, 'missing hosted Node setup step')
  assert.equal(nodeSetup.with['node-version-file'], '.nvmrc')
  assert.equal(nodeSetup.with['package-manager-cache'], false)
  assert.equal(Object.hasOwn(nodeSetup.with, 'cache'), false)
  assert.equal(Object.hasOwn(nodeSetup.with, 'cache-dependency-path'), false)
  assert.equal(STEPS.some((step) => step.name === 'Expose and validate Git cache tools'), false)

  assert.equal(hostedNodeSetup.with.cache, 'npm')
  assert.equal(hostedNodeSetup.with['cache-dependency-path'], 'frontend/package-lock.json')
})

test('BuildPlugin writes AutomationTool logs directly to one fresh run-attempt directory', () => {
  const prepare = stepNamed('Prepare scoped AutomationTool logs')
  const build = stepNamed('Build packaged plugin')

  assert.equal(prepare.id, 'automation_tool_logs')
  assertOrdered(prepare.run, [
    RUN_SUFFIX_ASSIGNMENT,
    '"UnrealEditorWebUI-AutomationToolLogs-$RunSuffix"',
    '"UnrealEditorWebUI-BuildPlugin-$RunSuffix.log"',
    'if (Test-Path -LiteralPath $AutomationToolLogDir)',
    'if (Test-Path -LiteralPath $BuildPluginConsoleLog)',
    'New-Item -ItemType Directory -Path $AutomationToolLogDir',
    '"directory=$AutomationToolLogDir"',
    '"console_log=$BuildPluginConsoleLog"',
    'Out-File -FilePath $env:GITHUB_OUTPUT',
  ])

  assert.equal(build.env.uebp_LogFolder, AUTOMATION_TOOL_DIRECTORY_OUTPUT)
  assert.equal(build.env.uebp_FinalLogFolder, AUTOMATION_TOOL_DIRECTORY_OUTPUT)
  assert.equal(build.env.UE_BUILDPLUGIN_CONSOLE_LOG, BUILDPLUGIN_CONSOLE_LOG_OUTPUT)
  assertOrdered(build.run, [
    '$AutomationToolLogDir = $env:uebp_LogFolder',
    'if ([string]::IsNullOrWhiteSpace($AutomationToolLogDir)',
    '$PreviousErrorActionPreference = $ErrorActionPreference',
    '$ErrorActionPreference = "Continue"',
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 -RunUAT $RunUAT -PackageDir $PackageDir -SourceCommit $env:GITHUB_SHA 2>&1 | Tee-Object -FilePath $env:UE_BUILDPLUGIN_CONSOLE_LOG',
    '$PackageExitCode = $LASTEXITCODE',
    '$ErrorActionPreference = $PreviousErrorActionPreference',
    'if (-not (Test-Path -LiteralPath $env:UE_BUILDPLUGIN_CONSOLE_LOG -PathType Leaf)',
    'Get-ChildItem -LiteralPath $AutomationToolLogDir -File -Recurse',
    'if ($AutomationToolLogFiles.Count -eq 0)',
  ])
  assert.equal((build.run.match(/if \(\$PackageExitCode -ne 0\)/gu) || []).length, 3)
  assert.ok(
    build.run.includes(
      [
        'if ($PackageExitCode -ne 0) {',
        '  Write-Host "::error::BuildPlugin failed with exit code $PackageExitCode. See $AutomationToolLogDir."',
        '  exit $PackageExitCode',
        '}',
      ].join('\n'),
    ),
    'the post-log failure block must propagate the original package exit code',
  )

  assert.doesNotMatch(WORKFLOW_SOURCE, /\$env:APPDATA/iu)
  assert.doesNotMatch(WORKFLOW_SOURCE, /Unreal Engine[\\/]AutomationTool[\\/]Logs/iu)
  assert.equal(STEPS.some((step) => step.name === 'Collect AutomationTool logs'), false)
})

test('BuildPlugin uses an exact commit and one fresh run-attempt package directory end to end', () => {
  const build = stepNamed('Build packaged plugin')
  const host = stepNamed('Create temporary host project')

  assertOrdered(build.run, [
    RUN_SUFFIX_ASSIGNMENT,
    SCOPED_PACKAGE_ASSIGNMENT,
    'if (Test-Path -LiteralPath $PackageDir)',
    'throw "Package directory is not fresh: $PackageDir"',
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 -RunUAT $RunUAT -PackageDir $PackageDir -SourceCommit $env:GITHUB_SHA 2>&1 | Tee-Object -FilePath $env:UE_BUILDPLUGIN_CONSOLE_LOG',
    '$SourceManifestPath = Join-Path $PackageDir "SourceManifest.json"',
    'if (-not (Test-Path -LiteralPath $SourceManifestPath -PathType Leaf))',
    '$SourceManifest = Get-Content -LiteralPath $SourceManifestPath -Raw | ConvertFrom-Json',
    'if ([string]$SourceManifest.sourceCommit -cne $env:GITHUB_SHA)',
    'if ([int]$SourceManifest.schemaVersion -ne 1)',
    '$ManifestFiles = @($SourceManifest.files)',
    '[string]$_.path -ceq "Web/dist/index.html" -and [string]$_.source -ceq "generated"',
    '[string]$_.path -ceq "LICENSE" -and [string]$_.source -ceq "tracked"',
    'if ($ManifestFrontend.Count -ne 1 -or $ManifestLicense.Count -ne 1)',
    '$PackagedLicense = Join-Path $PackageDir "LICENSE"',
    '$CommittedLicenseOutput = @(& git --no-replace-objects rev-parse "$($env:GITHUB_SHA):LICENSE")',
    'if ([string]$ManifestLicense[0].gitObject -cne $CommittedLicenseOutput[0].Trim())',
    '$PackagedLicenseOutput = @(& git --no-replace-objects hash-object --no-filters $PackagedLicense)',
    'if ($PackagedLicenseOutput[0].Trim() -ne $CommittedLicenseOutput[0].Trim())',
  ])
  assert.equal(
    build.run.includes(
      '$PackageDir = Join-Path $env:RUNNER_TEMP "UnrealEditorWebUI-Package"',
    ),
    false,
  )
  assert.equal(build.run.includes('git hash-object --no-filters LICENSE'), false)
  assert.doesNotMatch(build.run, /WorkingLicense|working-tree LICENSE|Get-FileHash/u)

  assertOrdered(host.run, [
    RUN_SUFFIX_ASSIGNMENT,
    '$PluginPackageDir = Join-Path $env:RUNNER_TEMP "UnrealEditorWebUI-Package-$RunSuffix"',
    'scripts/create-host-project.ps1 $ProjectDir $PluginPackageDir $env:UE_VERSION',
  ])
})

test('UE diagnostic uploads select only the current run and attempt', () => {
  const upload = stepNamed('Upload UE logs')
  const paths = upload.with.path.trim().split(/\r?\n/u)

  assert.equal(
    upload.if,
    "always() && steps.automation_tool_logs.outputs.directory != '' && steps.automation_tool_logs.outputs.console_log != ''",
  )
  assert.equal(upload.with.name, 'unreal-editor-webui-ue-logs')
  assert.deepEqual(paths, EXPECTED_LOG_PATHS)
  assert.equal(upload.with['if-no-files-found'], 'ignore')
  assert.equal(upload.with['retention-days'], 14)

  const currentRoot = 'C:/runner-temp/UnrealEditorWebUI-AutomationToolLogs-777-2'
  const priorAttemptRoot = currentRoot.replace(/-2$/u, '-1')
  const automationToolUpload = paths.at(-1)
  const renderedUpload = automationToolUpload
    .replace(AUTOMATION_TOOL_DIRECTORY_OUTPUT, currentRoot)
  assert.notEqual(currentRoot, priorAttemptRoot)
  assert.equal(renderedUpload, `${currentRoot}/**`)
  assert.equal(renderedUpload.startsWith(`${priorAttemptRoot}/`), false)
  assert.equal(paths.some((path) => path.includes('APPDATA')), false)
})

test('the release package identity stays unchanged and uploads before diagnostics', () => {
  const packageUpload = stepNamed('Upload packaged plugin')
  const logUpload = stepNamed('Upload UE logs')

  assert.ok(STEPS.indexOf(packageUpload) < STEPS.indexOf(logUpload))
  assert.equal(packageUpload.if, 'success()')
  assert.equal(
    packageUpload.with.name,
    "${{ github.event_name == 'workflow_dispatch' && inputs.ue_version == '5.3' && 'UnrealEditorWebUI-Package-UE53' || 'UnrealEditorWebUI-Package-UE58' }}",
  )
  assert.equal(packageUpload.with.path, EXPECTED_PACKAGE_UPLOAD_PATH)
  assert.equal(packageUpload.with['if-no-files-found'], 'error')
  assert.equal(packageUpload.with['retention-days'], 14)
})

test('release candidates require the exact-commit package source manifest', () => {
  const step = RELEASE_WORKFLOW.jobs.assemble.steps.find(
    ({ name }) => name === 'Validate packaged plugin structure',
  )
  assert.ok(step)
  assert.equal(step.env.RELEASE_COMMIT, '${{ steps.release.outputs.release_commit }}')
  assertOrdered(step.run, [
    'test -f trusted-package/SourceManifest.json',
    'value.schemaVersion !== 1',
    "file.path === 'Web/dist/index.html' && file.source === 'generated'",
    "process.stdout.write(value.sourceCommit ?? '')",
    'if [[ "$manifest_commit" != "$RELEASE_COMMIT" ]]',
  ])
})
