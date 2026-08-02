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
const JOB = WORKFLOW.jobs['buildplugin-and-automation']
const STEPS = JOB.steps
const AUTOMATION_TOOL_DIRECTORY_OUTPUT = '${{ steps.automation_tool_logs.outputs.directory }}'
const BUILDPLUGIN_CONSOLE_LOG_OUTPUT =
  '${{ steps.automation_tool_logs.outputs.console_log }}'
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

test('BuildPlugin writes AutomationTool logs directly to one fresh run-attempt directory', () => {
  const prepare = stepNamed('Prepare scoped AutomationTool logs')
  const build = stepNamed('Build packaged plugin')

  assert.equal(prepare.id, 'automation_tool_logs')
  assertOrdered(prepare.run, [
    '$RunSuffix = "$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"',
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
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 $RunUAT $PackageDir 2>&1 | Tee-Object -FilePath $env:UE_BUILDPLUGIN_CONSOLE_LOG',
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

test('the release package contract stays unchanged and uploads before diagnostics', () => {
  const packageUpload = stepNamed('Upload packaged plugin')
  const logUpload = stepNamed('Upload UE logs')

  assert.ok(STEPS.indexOf(packageUpload) < STEPS.indexOf(logUpload))
  assert.equal(packageUpload.if, 'success()')
  assert.equal(
    packageUpload.with.name,
    "${{ github.event_name == 'workflow_dispatch' && inputs.ue_version == '5.3' && 'UnrealEditorWebUI-Package-UE53' || 'UnrealEditorWebUI-Package-UE58' }}",
  )
  assert.equal(packageUpload.with.path, '${{ runner.temp }}/UnrealEditorWebUI-Package')
  assert.equal(packageUpload.with['if-no-files-found'], 'error')
  assert.equal(packageUpload.with['retention-days'], 14)
})
