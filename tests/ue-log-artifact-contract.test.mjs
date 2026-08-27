import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parse } from 'yaml'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_PATH = join(REPOSITORY_ROOT, '.github', 'workflows', 'ue-ci.yml')
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8')
const BROWSER_TEST_SOURCE = readFileSync(
  join(
    REPOSITORY_ROOT,
    'Source',
    'UnrealEditorWebUI',
    'Private',
    'Tests',
    'UnrealEditorWebUIBrowserTests.cpp',
  ),
  'utf8',
)
const WORKFLOW = parse(WORKFLOW_SOURCE)
const CI_WORKFLOW = parse(
  readFileSync(join(REPOSITORY_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
)
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
  '$RunSuffix = "$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-$env:UE_VARIANT_ID"'
const SCOPED_PACKAGE_ASSIGNMENT =
  '$PackageDir = Join-Path $env:RUNNER_TEMP "UnrealEditorWebUI-Package-$RunSuffix"'
const EXPECTED_PACKAGE_UPLOAD_PATH =
  '${{ runner.temp }}/UnrealEditorWebUI-Package-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}'
const EXPECTED_BUILD_ENVIRONMENT_PATH =
  '${{ runner.temp }}/UnrealEditorWebUI-BuildEnvironment-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}/BuildEnvironment.json'
const PYTHON_RESTRICTIVE_MODE_ARGUMENT =
  '-ini:Engine:[ConsoleVariables]:Engine.Python.IsPythonInRestrictiveMode=1'
const EXPECTED_LOG_PATHS = [
  '${{ runner.temp }}/UnrealEditorWebUI-Automation-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-PackagedBridgeSmoke-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-PackagedBridgeSmoke-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}.json',
  '${{ runner.temp }}/UnrealEditorWebUI-SettingsSmoke-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-BrowserAutomation-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}.log',
  '${{ runner.temp }}/UnrealEditorWebUI-BrowserAutomationReport-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}/**',
  '${{ runner.temp }}/UnrealEditorWebUI-HostProject-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.variant_id }}/Saved/Logs/**',
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
  assert.equal(
    hostedNodeSetup.with['cache-dependency-path'],
    'package-lock.json\nfrontend/package-lock.json\n',
  )
})

test('hosted checks validate the build-environment evidence tooling before the UE job', () => {
  const ueHostedStep = WORKFLOW.jobs['fast-checks'].steps.find(
    (step) => step.name === 'Validate UE build-environment evidence tooling',
  )
  const repositorySteps = CI_WORKFLOW.jobs.repository.steps
  const ciStep = repositorySteps.find((step) => step.name === 'Check release helper syntax')

  assert.ok(ueHostedStep, 'UE hosted prerequisites must validate build-environment evidence')
  assert.ok(ciStep, 'regular CI must validate release helper syntax')
  assertOrdered(ueHostedStep.run, [
    'node --check scripts/ue-release-variants.mjs',
    'node --check scripts/ue-build-environment.mjs',
    'node --test tests/ue-build-environment.test.mjs',
    'node --test tests/ue-build-environment-variants.test.mjs',
    'node --test tests/ue-multi-variant-contract.test.mjs',
  ])
  assertOrdered(ciStep.run, [
    'node --check scripts/ue-release-variants.mjs',
    'node --check scripts/ue-build-environment.mjs',
    'node --test tests/ue-build-environment.test.mjs',
    'node --test tests/ue-build-environment-variants.test.mjs',
    'node --test tests/ue-multi-variant-contract.test.mjs',
  ])
  assert.deepEqual(JOB.needs, ['fast-checks', 'ue-config-validation'])
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
  assert.ok(STEPS.indexOf(build) < STEPS.indexOf(host))

  assertOrdered(host.run, [
    RUN_SUFFIX_ASSIGNMENT,
    '$PluginPackageDir = Join-Path $env:RUNNER_TEMP "UnrealEditorWebUI-Package-$RunSuffix"',
    '$CatalogMarker = [guid]::NewGuid().ToString("N")',
    '$CatalogMarker -cnotmatch "^[0-9a-f]{32}$"',
    '$CatalogTemplate = Join-Path $PWD "tests/fixtures/tool-catalog/host-project-v1.template.json"',
    '$ToolPackSourceDirs = @(\n',
    'tests/fixtures/ue-tool-packs/AssetToolsFixture',
    'tests/fixtures/ue-tool-packs/LevelToolsFixture',
    'examples/tool-packs/ExampleAssetTools',
    '$ToolPackSourceDirsJson = ConvertTo-Json -InputObject $ToolPackSourceDirs -Compress',
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-host-project.ps1',
    '-ProjectDir $ProjectDir',
    '-PluginSourceDir $PluginPackageDir',
    '-EngineAssociation $env:UE_VERSION',
    '-ToolCatalogTemplate $CatalogTemplate',
    '-ToolCatalogMarker $CatalogMarker',
    '-ToolPackSourceDirsJson $ToolPackSourceDirsJson',
    '$ResolvedProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path',
    'throw "Temporary host project escaped RUNNER_TEMP."',
    '$ResolvedHostPluginPath = (Resolve-Path -LiteralPath $HostPluginPath).Path',
    'foreach ($BuildInputDirectory in @("Source", "Intermediate"))',
    'Remove-Item -LiteralPath $BuildInputPath -Recurse -Force',
    'throw "Binary-only host retained $BuildInputDirectory."',
    '$HostModuleManifests = @(Get-ChildItem -LiteralPath $HostBinariesPath -Filter "*.modules" -File)',
    '[string]$HostModules.BuildId -cne $env:UE_EXPECTED_BUILD_ID',
    'throw "Binary-only host module identity is invalid for $env:UE_RELEASE_VARIANT."',
    '"HOST_PROJECT=$ProjectPath"',
    '"UE_WEBUI_CATALOG_MARKER=$CatalogMarker"',
    '"UE_WEBUI_EXPECTED_TOOL_PACK_COUNT=$($ToolPackSourceDirs.Count)"',
    '"UE_WEBUI_TOOL_PACK_TEST=1"',
    'Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
  ])
})

test('host exports a validated version-specific Tool Pack count for the GUI contract', () => {
  const hostRun = stepNamed('Create temporary host project').run
  const fixturePaths = hostRun.match(
    /(?:tests\/fixtures\/ue-tool-packs|examples\/tool-packs)\/[A-Za-z0-9_-]+/gu,
  ) || []
  assert.equal(fixturePaths.length, 3)
  assert.equal(new Set(fixturePaths).size, 3)

  for (const version of ['5.4', '5.5', '5.8']) {
    assert.equal(fixturePaths.length, 3, `${version} must install the three retained packs`)
  }
  assert.doesNotMatch(hostRun, /\$ToolPackSourceDirs = @\(\)/u)
  assert.doesNotMatch(hostRun, /if \(\$env:UE_VERSION -eq "5\.8"\)[\s\S]*ToolPackSourceDirs/u)
  assert.match(
    hostRun,
    /"UE_WEBUI_EXPECTED_TOOL_PACK_COUNT=\$\(\$ToolPackSourceDirs\.Count\)"/u,
  )
  assert.doesNotMatch(hostRun, /UE_WEBUI_EXPECTED_TOOL_PACK_COUNT=[03]/u)

  assert.match(
    BROWSER_TEST_SOURCE,
    /GetEnvironmentVariable\(\s*TEXT\("UE_WEBUI_EXPECTED_TOOL_PACK_COUNT"\)\)/u,
  )
  assert.match(BROWSER_TEST_SOURCE, /TryParseExpectedToolPackCount/u)
  assert.match(BROWSER_TEST_SOURCE, /MaxExpectedToolPackCount = 384/u)
  assertOrdered(BROWSER_TEST_SOURCE, [
    'Value.IsEmpty() || (Value.Len() > 1 && Value[0] == TEXT(\'0\'))',
    'Character < TEXT(\'0\') || Character > TEXT(\'9\')',
    'ParsedCount > (MaxExpectedToolPackCount - Digit) / 10',
    'OutCount = ParsedCount',
  ])
  assert.match(BROWSER_TEST_SOURCE, /var expectedToolPackCount=%d;/u)
  assert.match(
    BROWSER_TEST_SOURCE,
    /report\.toolPacks\.loadedCount!==expectedToolPackCount/u,
  )
  assert.doesNotMatch(BROWSER_TEST_SOURCE, /report\.toolPacks\.loadedCount!==[0-9]+/u)
})

test('custom host catalog evidence reaches native automation and the packaged React DOM', () => {
  const host = stepNamed('Create temporary host project')
  const automation = stepNamed('Run UE automation tests')
  const gui = stepNamed('Run GUI CEF binding and task event test')
  const packagingContract = CI_WORKFLOW.jobs['packaging-windows'].steps.find(
    (step) => step.name === 'Test Windows packaging contracts',
  )

  assert.ok(packagingContract, 'Windows packaging must run the host-project contract')
  assertOrdered(packagingContract.run, [
    'node --test tests/package-plugin-registry-guard.test.mjs',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'node --test tests/create-host-project.test.mjs',
    'node --test tests/create-tool-pack.test.mjs',
    'node --test tests/add-tool-pack.test.mjs',
    'node --test tests/validate-tool-pack.test.mjs',
  ])
  assert.ok(STEPS.indexOf(host) < STEPS.indexOf(automation))
  assert.ok(STEPS.indexOf(automation) < STEPS.indexOf(gui))
  assert.match(automation.run, /"UnrealEditorWebUI\.Bridge\.ProjectToolCatalog"/u)
  assert.match(automation.run, /"UnrealEditorWebUI\.Bridge\.ThirdPartyToolPacks"/u)
  assert.match(automation.run, /"UnrealEditorWebUI\.Bridge\.WebUIHealth"/u)

  assert.match(
    BROWSER_TEST_SOURCE,
    /FPlatformMisc::GetEnvironmentVariable\(TEXT\("UE_WEBUI_CATALOG_MARKER"\)\)/u,
  )
  assertOrdered(BROWSER_TEST_SOURCE, [
    'data-tool-catalog-source=\\"project\\"',
    'data-tool-catalog-schema-version=\\"1\\"',
    'data-tool-project-id=\\"project-',
    'data-tool-stage-id=\\"stage-',
    'data-tool-category-id=\\"category-',
    "if(!projectCatalogReady()){phase('tool-catalog');state.readySince=0;return;}",
    "command:'system.ping'",
  ])
  assert.doesNotMatch(BROWSER_TEST_SOURCE, /gettoolcatalog/iu)
})

test('packaged GUI proves the closed health report through product DOM without leaking runtime evidence', () => {
  const guiSteps = STEPS.filter(
    (step) => step.name === 'Run GUI CEF binding and task event test',
  )
  assert.equal(guiSteps.length, 1, 'health evidence must reuse the existing GUI editor launch')
  assert.equal(
    (guiSteps[0].run.match(/^\s*& \$Editor\b.*$/gmu) || []).length,
    1,
    'the GUI evidence step must launch the editor exactly once',
  )

  assertOrdered(BROWSER_TEST_SOURCE, [
    "function healthPanel(){",
    "document.querySelector('[data-health-panel-toggle]')",
    'toggle.click()',
    "document.querySelector('[data-health-overall-status]')",
    "getAttribute('data-health-overall-status')!=='healthy'",
    'function supportReportText(panel,afterTask){',
    "panel.querySelector('[data-tool-pack-status=\\\"ready\\\"]')",
    "phase('tool-pack-status')",
    "panel.querySelector('[data-support-report-generate]')",
    'generate.click()',
    "panel.querySelector('textarea[data-support-report-preview]')",
  ])
  assert.match(
    BROWSER_TEST_SOURCE,
    /if\(afterTask&&text===state\.initialReportText\)\{generate\.click\(\);phase\('support-report-refresh'\);return null;\}/u,
    'post-task generation must retry if React had not published the aggregate count yet',
  )
  assert.doesNotMatch(
    BROWSER_TEST_SOURCE,
    /bridge\(\)\.(?:getwebuihealth|getprojectcontext|gettoolcatalog|getsupportreport)\b/iu,
    'CEF must observe the product UI instead of calling health/report bridge methods directly',
  )
  assert.doesNotMatch(
    BROWSER_TEST_SOURCE,
    /\.status\.ready|Bridge ready/iu,
    'CEF must use the versioned product health DOM instead of the removed binary bridge badge',
  )
  assert.match(
    BROWSER_TEST_SOURCE,
    /allowed\.indexOf\(reason\)!==-1\?reason:'browser_assertion'/u,
    'browser failures must collapse unknown exception text to a fixed reason code',
  )
  assert.match(BROWSER_TEST_SOURCE, /Reason == TEXT\("tool_pack_health"\)/u)
  assert.match(BROWSER_TEST_SOURCE, /Phase == TEXT\("tool-pack-status"\)/u)
  assert.match(BROWSER_TEST_SOURCE, /var passTitle='UEWEBUI_E2E_PASS';/u)
  assert.match(BROWSER_TEST_SOURCE, /var failTitle='UEWEBUI_E2E_FAIL:';/u)
  assert.match(BROWSER_TEST_SOURCE, /var waitTitle='UEWEBUI_E2E_WAIT:';/u)
  assert.doesNotMatch(
    BROWSER_TEST_SOURCE,
    /(?:passTitle|failTitle|waitTitle)=[^;]*nonce/u,
    'browser result and phase titles must not serialize the task nonce',
  )
  assert.match(
    BROWSER_TEST_SOURCE,
    /IsKnownBrowserFailureReason\(CandidateReason\)[\s\S]*FString\(TEXT\("browser_assertion"\)\)/u,
    'native test output must independently allowlist browser failure reasons',
  )
  assert.match(
    BROWSER_TEST_SOURCE,
    /Timed out waiting for the CEF round trip\. Loaded=%s phase=%s\./u,
    'timeouts may report only a fixed phase and loaded boolean',
  )
  assert.doesNotMatch(
    BROWSER_TEST_SOURCE,
    /BrowserWidget->GetUrl\(\)|URL='%s'|title='%s'/u,
    'CEF failure artifacts must not contain the loaded URL, title, or embedded nonce',
  )

  const validateStart = BROWSER_TEST_SOURCE.indexOf('function validateSupportReport(text,afterTask){')
  const validateEnd = BROWSER_TEST_SOURCE.indexOf('function healthPanel(){', validateStart)
  assert.ok(validateStart >= 0 && validateEnd > validateStart)
  const validateSource = BROWSER_TEST_SOURCE.slice(validateStart, validateEnd)
  assertOrdered(validateSource, [
    "exactKeys(report,['reportVersion','product','health','native','bridge','project','registry','catalog','toolPacks','tasks'],'report')",
    "report.reportVersion!==2||report.product!=='unreal-editor-webui'",
    "exactKeys(report.health,['overallStatus','reasonCodes'],'health')",
    "report.health.overallStatus!=='healthy'||!Array.isArray(report.health.reasonCodes)",
    "report.health.reasonCodes.length!==0",
    "exactKeys(report.native,['protocolVersion','bridgeProtocolVersion','pluginVersion','engineVersion'",
    'report.native.protocolVersion!==1||report.native.bridgeProtocolVersion!==1',
    "report.native.documentScope!=='packaged'",
    "report.native.pythonRuntime!=='available'",
    "report.native.privilegedConfirmation!=='per_call'",
    "report.native.taskSessionIsolation!=='document'",
    "report.bridge.lifecycle!=='ready'||report.bridge.diagnosticCode!==null",
    "report.project.persistence!=='enabled'",
    "report.registry.status!=='ready'",
    'report.registry.availableCount<1||report.registry.loadErrorCount!==0',
    "report.catalog.status!=='ready'||report.catalog.source!=='project'",
    'report.catalog.schemaVersion!==1||report.catalog.diagnosticCode!==null',
    "exactKeys(report.toolPacks,['status','diagnosticCode','statusVersion','coreApiVersion'",
    "report.toolPacks.status!=='ready'||report.toolPacks.diagnosticCode!==null",
    'report.toolPacks.statusVersion!==2||report.toolPacks.coreApiVersion!==1',
    'report.toolPacks.loadedCount!==expectedToolPackCount||report.toolPacks.rejectedCount!==0',
    'report.toolPacks.truncatedCount!==0||!Array.isArray(report.toolPacks.reasonCodes)',
    'report.toolPacks.reasonCodes.length!==0',
    "exactKeys(report.tasks,['queued','running','completed','failed','cancelled','timedOut','total'],'tasks')",
    "excluded(text,catalogMarker,'catalog_marker')",
    "excluded(text,'HostProject','project_name')",
    "excluded(text,window.location.href,'page_url')",
    "excluded(text,window.location.pathname,'page_path')",
    "excluded(text,nonce,'task_nonce')",
    "excluded(text,state.taskId,'task_id')",
    "excluded(text,state.taskResponseJson,'task_response')",
    "excluded(text,'cef-e2e','task_payload')",
    "excluded(text,'system.ping','task_command')",
    "excluded(text,'pong','task_result')",
  ])

  const verifyStart = BROWSER_TEST_SOURCE.indexOf('async function verify(){')
  const startStart = BROWSER_TEST_SOURCE.indexOf('async function start(){', verifyStart)
  const startEnd = BROWSER_TEST_SOURCE.indexOf(
    'window.setInterval(function(){void start();void verify();},100)',
    startStart,
  )
  assert.ok(verifyStart >= 0 && startStart > verifyStart && startEnd > startStart)
  const verifySource = BROWSER_TEST_SOURCE.slice(verifyStart, startStart)
  const startSource = BROWSER_TEST_SOURCE.slice(startStart, startEnd)

  assertOrdered(startSource, [
    "if(!projectCatalogReady()){phase('tool-catalog');state.readySince=0;return;}",
    'var panel=healthPanel()',
    'supportReportText(panel,false)',
    'validateSupportReport(initialReport,false)',
    "command:'system.ping'",
  ])
  assertOrdered(verifySource, [
    'state.taskResponseJson=String(taskEnvelope.result.responseJson',
    'state.taskVerified=true',
    'supportReportText(panel,true)',
    'validateSupportReport(refreshedReport,true)',
    `document.querySelector('[data-task-id=\\"'+state.taskId+'\\"]')`,
    'renderedCompletedEvent()',
    'document.title=passTitle',
  ])
  assert.match(
    BROWSER_TEST_SOURCE,
    /healthy native\/project\/catalog\/registry\/Tool Pack product state, allowlisted support-report DOM/iu,
  )
})

test('UE 5.8 editor launches isolate CI from user-global Python startup scripts', () => {
  assert.equal(JOB.env.UE_PYTHON_STARTUP_ISOLATION, PYTHON_RESTRICTIVE_MODE_ARGUMENT)

  const editorSteps = [
    'Run UE automation tests',
    'Run packaged bridge smoke',
    'Run native settings smoke',
    'Run GUI CEF binding and task event test',
  ]
  for (const name of editorSteps) {
    const run = stepNamed(name).run
    assertOrdered(run, [
      '$PythonIsolationArgs = @()',
      'if ($env:UE_VERSION -eq "5.8")',
      '$PythonIsolationArgs += $env:UE_PYTHON_STARTUP_ISOLATION',
      '$env:HOST_PROJECT @PythonIsolationArgs',
    ])
    assert.equal(
      run.split('$PythonIsolationArgs += $env:UE_PYTHON_STARTUP_ISOLATION').length - 1,
      1,
      `${name} must set the restrictive-mode override exactly once`,
    )
  }

  const editorLaunches = STEPS.flatMap((step) =>
    [...(step.run ?? '').matchAll(/^\s*& \$Editor(?:Cmd)?\b.*$/gmu)],
  )
  assert.equal(editorLaunches.length, 4, 'every protected UE editor launch must be enumerated')
  for (const launch of editorLaunches) {
    assert.match(launch[0], /\$env:HOST_PROJECT @PythonIsolationArgs\b/u)
  }
})

test('UE 5.4 and 5.5 validation reject user-global Python startup scripts before packaging', () => {
  const prerequisiteStep = stepNamed('Validate runner prerequisites')
  const prerequisites = prerequisiteStep.run

  assertOrdered(prerequisites, [
    'if ($env:UE_VERSION -ne "5.8")',
    '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)',
    '$UserPythonStartupScript = Join-Path $DocumentsPath "UnrealEngine/Python/init_unreal.py"',
    'Test-Path -LiteralPath $UserPythonStartupScript',
    '$env:UE_RELEASE_VARIANT cannot isolate user-global Python startup scripts.',
  ])
  assert.ok(STEPS.indexOf(prerequisiteStep) < STEPS.indexOf(stepNamed('Build packaged plugin')))
})

test('UE diagnostic uploads select only the current run and attempt', () => {
  const upload = stepNamed('Upload UE logs')
  const paths = upload.with.path.trim().split(/\r?\n/u)

  assert.equal(
    upload.if,
    "always() && steps.automation_tool_logs.outputs.directory != '' && steps.automation_tool_logs.outputs.console_log != ''",
  )
  assert.equal(upload.with.name, 'unreal-editor-webui-ue-logs-${{ matrix.variant_id }}')
  assert.deepEqual(paths, EXPECTED_LOG_PATHS)
  assert.equal(upload.with['if-no-files-found'], 'ignore')
  assert.equal(upload.with['retention-days'], 14)

  const currentRoot = 'C:/runner-temp/UnrealEditorWebUI-AutomationToolLogs-777-2-ue54'
  const priorAttemptRoot = currentRoot.replace(/-2-ue54$/u, '-1-ue54')
  const otherVariantRoot = currentRoot.replace(/-ue54$/u, '-ue55')
  const automationToolUpload = paths.at(-1)
  const renderedUpload = automationToolUpload
    .replace(AUTOMATION_TOOL_DIRECTORY_OUTPUT, currentRoot)
  assert.notEqual(currentRoot, priorAttemptRoot)
  assert.equal(renderedUpload, `${currentRoot}/**`)
  assert.equal(renderedUpload.startsWith(`${priorAttemptRoot}/`), false)
  assert.equal(renderedUpload.startsWith(`${otherVariantRoot}/`), false)
  assert.equal(paths.some((path) => path.includes('APPDATA')), false)
})

test('the release package identity stays unchanged and uploads before diagnostics', () => {
  const packageUpload = stepNamed('Upload packaged plugin')
  const evidenceCreate = stepNamed('Create exact UE build-environment evidence')
  const evidenceUpload = stepNamed('Upload exact UE build-environment evidence')
  const logUpload = stepNamed('Upload UE logs')

  assert.ok(STEPS.indexOf(packageUpload) < STEPS.indexOf(evidenceCreate))
  assert.ok(STEPS.indexOf(evidenceCreate) < STEPS.indexOf(evidenceUpload))
  assert.ok(STEPS.indexOf(evidenceUpload) < STEPS.indexOf(logUpload))
  assert.equal(packageUpload.id, 'package_artifact')
  assert.equal(packageUpload.if, 'success()')
  assert.equal(packageUpload.with.name, '${{ matrix.package_artifact }}')
  assert.equal(packageUpload.with.path, EXPECTED_PACKAGE_UPLOAD_PATH)
  assert.equal(packageUpload.with['if-no-files-found'], 'error')
  assert.equal(packageUpload.with['retention-days'], 14)
})

test('each exact UE variant evidence binds the completed package to the run-attempt environment', () => {
  const prerequisites = stepNamed('Validate runner prerequisites')
  const packageUpload = stepNamed('Upload packaged plugin')
  const create = stepNamed('Create exact UE build-environment evidence')
  const upload = stepNamed('Upload exact UE build-environment evidence')
  const diagnostics = stepNamed('Upload UE logs')

  for (const validationStep of [
    'Build packaged plugin',
    'Run UE automation tests',
    'Run packaged bridge smoke',
    'Run native settings smoke',
    'Run GUI CEF binding and task event test',
  ]) {
    assert.ok(
      STEPS.indexOf(stepNamed(validationStep)) < STEPS.indexOf(packageUpload),
      `${validationStep} must finish before the package artifact upload`,
    )
  }
  assert.ok(STEPS.indexOf(packageUpload) < STEPS.indexOf(create))
  assert.ok(STEPS.indexOf(create) < STEPS.indexOf(upload))
  assert.ok(STEPS.indexOf(upload) < STEPS.indexOf(diagnostics))
  assert.equal(STEPS.at(-1), diagnostics, 'the always-run diagnostics upload must remain last')

  assert.equal(create.id, 'build_environment')
  assert.equal(create.if, 'success()')
  assert.equal(prerequisites.id, 'runner_identity')
  assert.match(prerequisites.run, /npm --version/u)
  assert.equal(
    create.env.PACKAGE_ARTIFACT_ID,
    '${{ steps.package_artifact.outputs.artifact-id }}',
  )
  assert.equal(
    create.env.PACKAGE_ARTIFACT_DIGEST,
    '${{ steps.package_artifact.outputs.artifact-digest }}',
  )
  assert.equal(
    create.env.UE_BUILDPLUGIN_CONSOLE_LOG,
    BUILDPLUGIN_CONSOLE_LOG_OUTPUT,
  )
  assert.equal(
    create.env.UE_AUTOMATION_TOOL_LOG_DIR,
    AUTOMATION_TOOL_DIRECTORY_OUTPUT,
  )
  assertOrdered(create.run, [
    RUN_SUFFIX_ASSIGNMENT,
    '"UnrealEditorWebUI-Package-$RunSuffix"',
    '"SourceManifest.json"',
    '"Engine/Build/Build.version"',
    '"Engine/Binaries/Win64/UnrealEditor.version"',
    '"UnrealEditorWebUI-BuildEnvironment-$RunSuffix"',
    '$OutputPath = Join-Path $OutputDirectory "BuildEnvironment.json"',
    'if (Test-Path -LiteralPath $OutputDirectory)',
    '$PackageArtifactDigest = "sha256:$($env:PACKAGE_ARTIFACT_DIGEST)"',
    'New-Item -ItemType Directory -Path $OutputDirectory',
    '& node scripts/ue-build-environment.mjs create',
    '--console-log $env:UE_BUILDPLUGIN_CONSOLE_LOG',
    '--log-directory $env:UE_AUTOMATION_TOOL_LOG_DIR',
    '--build-version $BuildVersionPath',
    '--editor-version $EditorVersionPath',
    '--source-manifest $SourceManifestPath',
    '--package-directory $PackageDir',
    '--variant $env:UE_VARIANT_ID',
    '--embedded-python-version $env:UE_DETECTED_PYTHON_VERSION',
    '--cef-product-version $env:UE_DETECTED_CEF_PRODUCT_VERSION',
    '--cef-chromium-version $env:UE_DETECTED_CEF_CHROMIUM_VERSION',
    '--package-artifact-id $env:PACKAGE_ARTIFACT_ID',
    '--package-artifact-name $PackageArtifactName',
    '--package-artifact-digest $PackageArtifactDigest',
    '--repository $env:GITHUB_REPOSITORY',
    '--commit $env:GITHUB_SHA',
    '--run-id $env:GITHUB_RUN_ID',
    '--run-attempt $env:GITHUB_RUN_ATTEMPT',
    '--job-key $env:GITHUB_JOB',
    '--job-name $env:UE_JOB_NAME',
    '--output $OutputPath',
    'if ($LASTEXITCODE -ne 0)',
    '"path=$OutputPath"',
  ])
  assert.ok(create.run.includes('$PackageArtifactName = $env:UE_PACKAGE_ARTIFACT_NAME'))
  assert.doesNotMatch(
    create.run,
    /--node-version|--node-architecture|--npm-version|npm --version/iu,
  )

  assert.equal(upload.uses, packageUpload.uses)
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u)
  assert.equal(
    upload.if,
    "success() && steps.build_environment.outputs.path != ''",
  )
  assert.equal(upload.with.name, '${{ matrix.build_environment_artifact }}')
  assert.equal(upload.with.path, EXPECTED_BUILD_ENVIRONMENT_PATH)
  assert.equal(upload.with.path.includes('\n'), false, 'the evidence artifact must upload one file')
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(upload.with['retention-days'], 14)
  assert.ok(
    create.run.includes(
      '$OutputPath = Join-Path $OutputDirectory "BuildEnvironment.json"',
    ),
  )
})

test('release candidates require the exact-commit package source manifest', () => {
  const step = RELEASE_WORKFLOW.jobs.assemble.steps.find(
    ({ name }) => name === 'Validate every packaged plugin identity',
  )
  assert.ok(step)
  assert.equal(step.env.RELEASE_COMMIT, '${{ steps.release.outputs.release_commit }}')
  assertOrdered(step.run, [
    'for variant_id in ue54 ue55 ue58',
    'test -f "$package/SourceManifest.json"',
    'value.schemaVersion !== 1',
    "file.path === 'Web/dist/index.html' && file.source === 'generated'",
    "process.stdout.write(value.sourceCommit ?? '')",
    'if [[ "$manifest_commit" != "$RELEASE_COMMIT" ]]',
    'cmp -s LICENSE "$package/LICENSE"',
    'node scripts/validate-plugin-version.mjs',
    'modules.BuildId !== variant.engine.buildId',
  ])
})
