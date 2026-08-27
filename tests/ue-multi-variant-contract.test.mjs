import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

import {
  RELEASE_VARIANTS,
  releaseWorkflowMatrix,
} from '../scripts/ue-release-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

const workflowText = read('.github/workflows/ue-ci.yml')
const workflow = parse(workflowText)
const job = workflow.jobs['buildplugin-and-automation']

function step(name) {
  const found = job.steps.find((candidate) => candidate.name === name)
  assert.ok(found, `missing workflow step: ${name}`)
  return found
}

test('hosted config emits the only matrix source and protected jobs run serially', () => {
  const config = workflow.jobs['ue-config-validation']
  assert.equal(config.outputs.release_matrix, '${{ steps.release_variants.outputs.matrix }}')
  const emit = config.steps.find(({ id }) => id === 'release_variants')
  assert.match(emit.run, /node scripts\/ue-release-variants\.mjs workflow-matrix/u)
  assert.equal(job.strategy['fail-fast'], false)
  assert.equal(job.strategy['max-parallel'], 1)
  assert.equal(
    job.strategy.matrix,
    '${{ fromJSON(needs.ue-config-validation.outputs.release_matrix) }}',
  )
  assert.deepEqual(job['runs-on'], [
    'self-hosted',
    'windows',
    'gui',
    '${{ matrix.runner_label }}',
  ])
  assert.deepEqual(releaseWorkflowMatrix().include.map(({ variant_id }) => variant_id), [
    'ue54',
    'ue55',
    'ue58',
  ])
})

test('the closed matrix carries every exact engine, runtime, toolchain, and artifact identity', () => {
  const matrix = releaseWorkflowMatrix().include
  assert.equal(matrix.length, 3)
  assert.deepEqual(
    RELEASE_VARIANTS.map(({ id, engineAssociation, releaseVariant }) => ({
      id,
      engineAssociation,
      releaseVariant,
    })),
    [
      { id: 'ue54', engineAssociation: '5.4', releaseVariant: 'UE54-Win64' },
      { id: 'ue55', engineAssociation: '5.5', releaseVariant: 'UE55-Win64' },
      { id: 'ue58', engineAssociation: '5.8', releaseVariant: 'UE58-Win64' },
    ],
  )
  assert.deepEqual(
    RELEASE_VARIANTS.map((variant) => ({
      engine: variant.engine,
      toolchain: variant.toolchain,
      embeddedPythonVersion: variant.embeddedPythonVersion,
      cefProductVersion: variant.cefProductVersion,
      cefChromiumVersion: variant.cefChromiumVersion,
    })),
    [
      {
        engine: {
          majorVersion: 5,
          minorVersion: 4,
          patchVersion: 4,
          changelist: 35576357,
          compatibleChangelist: 33043543,
          branchName: '++UE5+Release-5.4',
          buildId: '33043543',
        },
        toolchain: {
          visualStudioVersion: '2022',
          familyVersion: '14.38.33130',
          productVersion: '14.38.33145',
          windowsSdkVersion: '10.0.19041.0',
        },
        embeddedPythonVersion: '3.11.8',
        cefProductVersion: '90.6.7+g19ba721+chromium-90.0.4430.212',
        cefChromiumVersion: '90.0.4430.212',
      },
      {
        engine: {
          majorVersion: 5,
          minorVersion: 5,
          patchVersion: 4,
          changelist: 40574608,
          compatibleChangelist: 37670630,
          branchName: '++UE5+Release-5.5',
          buildId: '37670630',
        },
        toolchain: {
          visualStudioVersion: '2022',
          familyVersion: '14.38.33130',
          productVersion: '14.38.33145',
          windowsSdkVersion: '10.0.22621.0',
        },
        embeddedPythonVersion: '3.11.8',
        cefProductVersion: '90.6.7+g19ba721+chromium-90.0.4430.212',
        cefChromiumVersion: '90.0.4430.212',
      },
      {
        engine: {
          majorVersion: 5,
          minorVersion: 8,
          patchVersion: 0,
          changelist: 55116800,
          compatibleChangelist: 0,
          branchName: '++UE5+Release-5.8',
          buildId: '55116800',
        },
        toolchain: {
          visualStudioVersion: '2022',
          familyVersion: '14.44.35207',
          productVersion: '14.44.35219',
          windowsSdkVersion: '10.0.22621.0',
        },
        embeddedPythonVersion: '3.11.8',
        cefProductVersion: '128.4.13+ge76af7e+chromium-128.0.6613.138',
        cefChromiumVersion: '128.0.6613.138',
      },
    ],
  )
  for (const [index, variant] of RELEASE_VARIANTS.entries()) {
    assert.deepEqual(matrix[index], {
      variant_id: variant.id,
      release_variant: variant.releaseVariant,
      ue_version: variant.engineAssociation,
      ue_root: variant.engineRoot,
      runner_label: variant.runnerLabel,
      job_name: variant.jobName,
      package_artifact: variant.packageArtifactName,
      build_environment_artifact: variant.buildEnvironmentArtifactName,
      patch_version: variant.engine.patchVersion,
      changelist: variant.engine.changelist,
      compatible_changelist: variant.engine.compatibleChangelist,
      branch_name: variant.engine.branchName,
      build_id: variant.engine.buildId,
      python_version: variant.embeddedPythonVersion,
      cef_product_version: variant.cefProductVersion,
      cef_chromium_version: variant.cefChromiumVersion,
      visual_studio_version: variant.toolchain.visualStudioVersion,
      toolchain_family_version: variant.toolchain.familyVersion,
      compiler_product_version: variant.toolchain.productVersion,
      windows_sdk_version: variant.toolchain.windowsSdkVersion,
    })
  }
})

test('runner preflight validates full engine, BuildId, Python, CEF, and interactive GUI identity', () => {
  const run = step('Validate runner prerequisites').run
  for (const fragment of [
    'Engine/Build/Build.version',
    'Engine/Binaries/Win64/UnrealEditor.version',
    'Engine/Binaries/Win64/UnrealEditor.modules',
    'Engine/Binaries/ThirdParty/Python3/Win64/python.exe',
    'Engine/Binaries/ThirdParty/CEF3/Win64',
    'UE_EXPECTED_PATCH_VERSION',
    'UE_EXPECTED_CHANGELIST',
    'UE_EXPECTED_COMPATIBLE_CHANGELIST',
    'UE_EXPECTED_BRANCH_NAME',
    'UE_EXPECTED_BUILD_ID',
    'UE_EXPECTED_PYTHON_VERSION',
    'UE_EXPECTED_CEF_PRODUCT_VERSION',
    'UE_EXPECTED_VISUAL_STUDIO_VERSION',
    'UE_EXPECTED_TOOLCHAIN_FAMILY_VERSION',
    'UE_EXPECTED_COMPILER_PRODUCT_VERSION',
    'UE_EXPECTED_WINDOWS_SDK_VERSION',
    'vswhere.exe',
    'VC/Tools/MSVC/',
    'Windows Kits\\10\\bin',
    'Get-Process -Name explorer',
  ]) assert.match(run, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.equal(step('Validate runner prerequisites').id, 'runner_identity')
  assert.match(run, /embedded_python_version=\$DetectedPythonVersion/u)
  assert.match(run, /cef_product_version=\$DetectedCefProductVersion/u)
  assert.match(run, /if \(\$env:UE_VERSION -ne "5\.8"\)/u)
  assert.match(run, /user-global Python startup scripts/u)
})

test('all temporary package, host, test, report, and evidence paths include the variant id', () => {
  const selfHosted = job.steps.map(({ run = '', with: withValue = {} }) =>
    `${run}\n${JSON.stringify(withValue)}`,
  ).join('\n')
  assert.match(selfHosted, /GITHUB_RUN_ATTEMPT\)-\$env:UE_VARIANT_ID/u)
  for (const base of [
    'UnrealEditorWebUI-Package-',
    'UnrealEditorWebUI-HostProject-',
    'UnrealEditorWebUI-Automation-',
    'UnrealEditorWebUI-PackagedBridgeSmoke-',
    'UnrealEditorWebUI-SettingsSmoke-',
    'UnrealEditorWebUI-BrowserAutomation-',
    'UnrealEditorWebUI-BuildEnvironment-',
  ]) assert.match(selfHosted, new RegExp(base, 'u'))
  assert.equal(step('Upload packaged plugin').with.name, '${{ matrix.package_artifact }}')
  assert.match(step('Upload packaged plugin').with.path, /matrix\.variant_id/u)
  assert.equal(
    step('Upload exact UE build-environment evidence').with.name,
    '${{ matrix.build_environment_artifact }}',
  )
  assert.match(step('Upload exact UE build-environment evidence').with.path, /matrix\.variant_id/u)
  assert.equal(step('Upload UE logs').with.name, 'unreal-editor-webui-ue-logs-${{ matrix.variant_id }}')
})

test('every variant host installs the retained three-pack v1/v2 coverage', () => {
  const host = step('Create temporary host project').run
  for (const toolPack of ['AssetToolsFixture', 'LevelToolsFixture', 'ExampleAssetTools']) {
    assert.match(host, new RegExp(toolPack, 'u'))
  }
  assert.match(host, /UE_WEBUI_EXPECTED_TOOL_PACK_COUNT=\$\(\$ToolPackSourceDirs\.Count\)/u)
  assert.match(host, /UE_WEBUI_TOOL_PACK_TEST=1/u)
  assert.doesNotMatch(host, /if \(\$env:UE_VERSION -eq "5\.8"\).*ToolPackSourceDirs/su)

  const automation = step('Run UE automation tests').run
  assert.match(automation, /UnrealEditorWebUI\.Bridge\.ThirdPartyToolPacks/u)
  const cpp = read('Source/UnrealEditorWebUI/Private/Tests/UnrealEditorWebUIBridgeTests.cpp')
  assert.match(cpp, /reports exactly three Tool Packs/u)
  assert.match(cpp, /fixture\.asset\.echo/u)
  assert.match(cpp, /fixture\.level\.echo/u)
  assert.match(cpp, /example\.assets\.selectionSummary/u)
})

test('the packaged host deletes build inputs and checks it never recompiles the plugin', () => {
  const build = step('Build packaged plugin').run
  assert.match(build, /\$PackagedDescriptor\.Installed -ne \$true/u)
  assert.match(build, /\$PackagedDescriptor\.EngineVersion -cne \$ExpectedPackagedEngineVersion/u)
  const host = step('Create temporary host project').run
  assert.match(host, /Temporary host project escaped RUNNER_TEMP/u)
  assert.match(host, /@\("Source", "Intermediate"\)/u)
  assert.match(host, /\$ResolvedHostPluginRoot = \$ResolvedHostPluginPath\.TrimEnd/u)
  assert.match(host, /\[System\.IO\.FileAttributes\]::ReparsePoint/u)
  assert.match(host, /\$ResolvedBuildInputPath \+ '\\'\)\.StartsWith\(\$ResolvedHostPluginRoot/u)
  assert.match(host, /Binary-only build input escaped the temporary host plugin/u)
  assert.match(host, /Remove-Item -LiteralPath \$BuildInputPath -Recurse -Force/u)
  assert.match(host, /UnrealEditor-UnrealEditorWebUI\.dll/u)
  assert.match(host, /UE_WEBUI_BINARY_ONLY_HOST=1/u)
  const noRebuild = step('Assert the host stayed binary-only').run
  assert.match(noRebuild, /Running UnrealBuildTool/u)
  assert.match(noRebuild, /Compiling UnrealEditorWebUI/u)
  assert.match(noRebuild, /Binary-only host attempted a plugin rebuild/u)
})

test('each job runs BuildPlugin, bridge/settings smoke, and real GUI CEF coverage', () => {
  for (const name of [
    'Build packaged plugin',
    'Run UE automation tests',
    'Run packaged bridge smoke',
    'Run native settings smoke',
    'Run GUI CEF binding and task event test',
  ]) step(name)
  const gui = step('Run GUI CEF binding and task event test').run
  assert.match(gui, /UnrealEditor\.exe/u)
  assert.match(gui, /UnrealEditorWebUI\.Browser\.CEFBindingAndTaskEvent/u)
  assert.doesNotMatch(gui, /-NullRHI/u)
})

test('schema 2 evidence consumes detected runtime values and exact package/editor identity', () => {
  const create = step('Create exact UE build-environment evidence')
  assert.equal(create.if, 'success()')
  assert.equal(
    create.env.UE_DETECTED_PYTHON_VERSION,
    '${{ steps.runner_identity.outputs.embedded_python_version }}',
  )
  assert.equal(
    create.env.UE_DETECTED_CEF_PRODUCT_VERSION,
    '${{ steps.runner_identity.outputs.cef_product_version }}',
  )
  for (const fragment of [
    '--editor-version $EditorVersionPath',
    '--package-directory $PackageDir',
    '--variant $env:UE_VARIANT_ID',
    '--embedded-python-version $env:UE_DETECTED_PYTHON_VERSION',
    '--cef-product-version $env:UE_DETECTED_CEF_PRODUCT_VERSION',
    '--cef-chromium-version $env:UE_DETECTED_CEF_CHROMIUM_VERSION',
    '--job-name $env:UE_JOB_NAME',
  ]) assert.match(create.run, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

test('frontend output is pinned to the oldest maintained Chromium contract', () => {
  const vite = read('frontend/vite.config.ts')
  const tsconfig = read('frontend/tsconfig.app.json')
  assert.match(vite, /target: 'chrome90'/u)
  assert.match(vite, /cssTarget: 'chrome90'/u)
  assert.match(tsconfig, /"target":\s*"ES2020"/u)
  assert.match(tsconfig, /"lib":\s*\["ES2020",\s*"DOM"\]/u)
})

test('runner setup accepts only closed variants and validates their full local prerequisites', () => {
  const setup = read('scripts/setup-ue-runner.ps1')
  assert.match(setup, /\[ValidateSet\("ue54", "ue55", "ue58"\)\]/u)
  assert.match(setup, /ue-release-variants\.mjs/u)
  assert.match(setup, /validate-node-version\.mjs/u)
  assert.match(setup, /workflow-matrix/u)
  for (const fragment of [
    'Build.version',
    'UnrealEditor.version',
    'UnrealEditor.modules',
    'embedded Python',
    'CEF runtime',
    'ExpectedToolchainFamily',
    'ExpectedCompilerProduct',
    'ExpectedSdkVersion',
    '--disableupdate',
  ]) assert.match(setup, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.doesNotMatch(setup, /--replace/u)
  assert.doesNotMatch(setup, /\[string\]\$Labels|\[string\]\$UERoot|\[string\]\$RunnerRoot/u)
})
