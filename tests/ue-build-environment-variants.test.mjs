import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUILD_ENVIRONMENT_SCHEMA_VERSION,
  collectUbtBuildEnvironment,
  EXPECTED_JOB_KEY,
  EXPECTED_WORKFLOW_NAME,
  EXPECTED_WORKFLOW_PATH,
} from '../scripts/ue-build-environment.mjs'
import { RELEASE_VARIANTS } from '../scripts/ue-release-variants.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRIPT_PATH = join(REPOSITORY_ROOT, 'scripts', 'ue-build-environment.mjs')
const SOURCE_COMMIT = 'a'.repeat(40)
const PACKAGE_DIGEST = `sha256:${'b'.repeat(64)}`
const REPOSITORY = 'zhuoxyang/unreal-editor-webui'
const RUN_ID = '30771833666'
const RUN_ATTEMPT = '2'
const PACKAGE_ARTIFACT_ID = '987654321'

function versionDocument(variant, includeBuildId) {
  return {
    MajorVersion: variant.engine.majorVersion,
    MinorVersion: variant.engine.minorVersion,
    PatchVersion: variant.engine.patchVersion,
    Changelist: variant.engine.changelist,
    CompatibleChangelist: variant.engine.compatibleChangelist,
    IsLicenseeVersion: 0,
    IsPromotedBuild: 1,
    BranchName: variant.engine.branchName,
    ...(includeBuildId ? { BuildId: variant.engine.buildId } : {}),
  }
}

function sourceManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceCommit: SOURCE_COMMIT,
    buildToolchain: {
      nodeVersion: '24.18.1',
      nodeArchitecture: 'x64',
      npmVersion: '11.16.0',
    },
    files: [{ path: 'Web/dist/index.html', sha256: 'c'.repeat(64) }],
    ...overrides,
  }
}

function ubaLog(variant, overrides = {}) {
  const family = overrides.family ?? variant.toolchain.familyVersion
  const product = overrides.product ?? variant.toolchain.productVersion
  const sdk = overrides.sdk ?? variant.toolchain.windowsSdkVersion
  const toolchainRoot = `C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\${family}`
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10'
  return [
    `Compiler: ${toolchainRoot}\\bin\\Hostx64\\x64\\cl.exe`,
    `Resource Compiler: ${sdkRoot}\\bin\\${sdk}\\x64\\rc.exe`,
    `Using Visual Studio 2022 ${product} toolchain (${toolchainRoot}) and Windows ${sdk} SDK (${sdkRoot}).`,
  ].join('\r\n') + '\r\n'
}

function createFixture(variant, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ue-build-environment-'))
  const logDirectory = join(root, 'automation-logs')
  mkdirSync(logDirectory)
  const ubaPath = join(logDirectory, 'UBA-UnrealEditor-Win64-Development.txt')
  writeFileSync(ubaPath, overrides.log ?? ubaLog(variant), 'utf8')
  const consoleLog = join(root, 'BuildPlugin-console.log')
  writeFileSync(
    consoleLog,
    `Running: dotnet UnrealBuildTool.dll UnrealEditor Win64 Development -log="${ubaPath}"`,
    'utf8',
  )
  const buildVersionPath = join(root, 'Build.version')
  writeFileSync(
    buildVersionPath,
    JSON.stringify(overrides.build ?? versionDocument(variant, false)),
    'utf8',
  )
  const editorVersionPath = join(root, 'UnrealEditor.version')
  writeFileSync(
    editorVersionPath,
    JSON.stringify(overrides.editor ?? versionDocument(variant, true)),
    'utf8',
  )
  const sourceManifestPath = join(root, 'SourceManifest.json')
  writeFileSync(
    sourceManifestPath,
    JSON.stringify(overrides.manifest ?? sourceManifest()),
    'utf8',
  )
  const packageDirectory = join(root, 'package')
  const binariesDirectory = join(packageDirectory, 'Binaries', 'Win64')
  mkdirSync(binariesDirectory, { recursive: true })
  writeFileSync(
    join(packageDirectory, 'UnrealEditorWebUI.uplugin'),
    JSON.stringify(
      overrides.descriptor ?? {
        Installed: true,
        EngineVersion: `${variant.engineAssociation}.0`,
      },
    ),
    'utf8',
  )
  writeFileSync(
    join(binariesDirectory, 'UnrealEditor.modules'),
    JSON.stringify(
      overrides.modules ?? {
        BuildId: variant.engine.buildId,
        Modules: { UnrealEditorWebUI: 'UnrealEditor-UnrealEditorWebUI.dll' },
      },
    ),
    'utf8',
  )
  if (overrides.dll !== false) {
    writeFileSync(
      join(binariesDirectory, 'UnrealEditor-UnrealEditorWebUI.dll'),
      typeof overrides.dll === 'string' ? overrides.dll : 'binary',
      'utf8',
    )
  }
  return {
    root,
    logDirectory,
    consoleLog,
    buildVersionPath,
    editorVersionPath,
    sourceManifestPath,
    packageDirectory,
    output: join(root, 'BuildEnvironment.json'),
    canonicalOutput: join(root, 'BuildEnvironment.canonical.json'),
  }
}

function createArguments(fixture, variant, overrides = {}) {
  const values = {
    'console-log': fixture.consoleLog,
    'log-directory': fixture.logDirectory,
    'build-version': fixture.buildVersionPath,
    'editor-version': fixture.editorVersionPath,
    'source-manifest': fixture.sourceManifestPath,
    'package-directory': fixture.packageDirectory,
    variant: variant.id,
    'embedded-python-version': variant.embeddedPythonVersion,
    'cef-product-version': variant.cefProductVersion,
    'cef-chromium-version': variant.cefChromiumVersion,
    'package-artifact-id': PACKAGE_ARTIFACT_ID,
    'package-artifact-name': variant.packageArtifactName,
    'package-artifact-digest': PACKAGE_DIGEST,
    repository: REPOSITORY,
    commit: SOURCE_COMMIT,
    'run-id': RUN_ID,
    'run-attempt': RUN_ATTEMPT,
    'job-key': EXPECTED_JOB_KEY,
    'job-name': variant.jobName,
    'workflow-name': EXPECTED_WORKFLOW_NAME,
    output: fixture.output,
    ...overrides,
  }
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, String(value)])
}

function verifyArguments(fixture, variant, overrides = {}) {
  const values = {
    input: fixture.output,
    variant: variant.id,
    repository: REPOSITORY,
    commit: SOURCE_COMMIT,
    'run-id': RUN_ID,
    'run-attempt': RUN_ATTEMPT,
    'job-key': EXPECTED_JOB_KEY,
    'package-artifact-id': PACKAGE_ARTIFACT_ID,
    'package-artifact-name': variant.packageArtifactName,
    'package-artifact-digest': PACKAGE_DIGEST,
    'canonical-output': fixture.canonicalOutput,
    ...overrides,
  }
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, String(value)])
}

function runCli(command, args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, command, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function outputOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function assertSuccess(result) {
  assert.equal(result.status, 0, outputOf(result))
}

for (const variant of RELEASE_VARIANTS) {
  test(`creates and verifies closed schema 2 evidence for ${variant.releaseVariant}`, () => {
    const fixture = createFixture(variant)
    try {
      assertSuccess(runCli('create', createArguments(fixture, variant)))
      const text = readFileSync(fixture.output, 'utf8')
      const document = JSON.parse(text)
      const { buildId: _buildId, ...expectedEngine } = variant.engine
      assert.equal(document.schemaVersion, BUILD_ENVIRONMENT_SCHEMA_VERSION)
      assert.equal(document.releaseVariant, variant.releaseVariant)
      assert.equal(document.buildId, variant.engine.buildId)
      assert.deepEqual(document.unrealEngine, {
        ...expectedEngine,
        isLicenseeVersion: false,
        isPromotedBuild: true,
      })
      assert.equal(document.compiler.toolchainFamilyVersion, variant.toolchain.familyVersion)
      assert.equal(document.compiler.compilerProductVersion, variant.toolchain.productVersion)
      assert.equal(document.windowsSdk.version, variant.toolchain.windowsSdkVersion)
      assert.deepEqual(document.runtime, {
        embeddedPythonVersion: variant.embeddedPythonVersion,
        cefProductVersion: variant.cefProductVersion,
        cefChromiumVersion: variant.cefChromiumVersion,
      })
      assert.equal(document.packageArtifact.artifactName, variant.packageArtifactName)
      assertSuccess(runCli('verify', verifyArguments(fixture, variant)))
      assert.equal(readFileSync(fixture.canonicalOutput, 'utf8'), text)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

test('collects one complete exact UBT tuple without serializing paths', () => {
  const variant = RELEASE_VARIANTS[0]
  const fixture = createFixture(variant)
  try {
    const selected = collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory)
    assert.equal(selected.compiler.compilerProductVersion, variant.toolchain.productVersion)
    assert.equal(selected.windowsSdk.version, variant.toolchain.windowsSdkVersion)
    assert.equal(JSON.stringify(selected).includes('Program Files'), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
test('rejects cross-variant engine, runtime, compiler, SDK, and package subjects', () => {
  const variant = RELEASE_VARIANTS[0]
  const other = RELEASE_VARIANTS[1]
  const cases = [
    { fixture: { build: versionDocument(other, false) }, args: {} },
    { fixture: { editor: versionDocument(other, true) }, args: {} },
    { fixture: { log: ubaLog(variant, { sdk: other.toolchain.windowsSdkVersion }) }, args: {} },
    { fixture: {}, args: { 'embedded-python-version': '3.11.9' } },
    { fixture: {}, args: { 'package-artifact-name': other.packageArtifactName } },
    { fixture: { descriptor: { Installed: true, EngineVersion: `${other.engineAssociation}.0` } }, args: {} },
    { fixture: { descriptor: { Installed: false, EngineVersion: `${variant.engineAssociation}.0` } }, args: {} },
    { fixture: { modules: { BuildId: other.engine.buildId, Modules: { UnrealEditorWebUI: 'UnrealEditor-UnrealEditorWebUI.dll' } } }, args: {} },
  ]
  for (const entry of cases) {
    const fixture = createFixture(variant, entry.fixture)
    try {
      const result = runCli('create', createArguments(fixture, variant, entry.args))
      assert.equal(result.status, 1, outputOf(result))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('rejects missing, empty, renamed, and extra packaged module binaries', () => {
  const variant = RELEASE_VARIANTS[2]
  const cases = [
    { dll: false },
    { dll: '' },
    { modules: { BuildId: variant.engine.buildId, Modules: { UnrealEditorWebUI: '../escape.dll' } } },
    { modules: { BuildId: variant.engine.buildId, Modules: { Other: 'Other.dll', UnrealEditorWebUI: 'UnrealEditor-UnrealEditorWebUI.dll' } } },
  ]
  for (const entry of cases) {
    const fixture = createFixture(variant, entry)
    try {
      const result = runCli('create', createArguments(fixture, variant))
      assert.equal(result.status, 1, outputOf(result))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('verify rejects variant, BuildId, runtime, and exact artifact binding tampering', () => {
  const variant = RELEASE_VARIANTS[1]
  const fixture = createFixture(variant)
  try {
    assertSuccess(runCli('create', createArguments(fixture, variant)))
    const original = readFileSync(fixture.output, 'utf8')
    for (const mutate of [
      (value) => { value.releaseVariant = 'UE54-Win64' },
      (value) => { value.buildId = '33043543' },
      (value) => { value.runtime.embeddedPythonVersion = '3.11.9' },
      (value) => { value.packageArtifact.artifactDigest = `sha256:${'c'.repeat(64)}` },
      (value) => { value.machinePath = 'C:\\secret' },
    ]) {
      const document = JSON.parse(original)
      mutate(document)
      writeFileSync(fixture.output, JSON.stringify(document), 'utf8')
      const result = runCli('verify', verifyArguments(fixture, variant))
      assert.equal(result.status, 1, outputOf(result))
      rmSync(fixture.canonicalOutput, { force: true })
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('create and verify refuse to overwrite evidence files', () => {
  const variant = RELEASE_VARIANTS[2]
  const fixture = createFixture(variant)
  try {
    writeFileSync(fixture.output, 'sentinel', 'utf8')
    const createResult = runCli('create', createArguments(fixture, variant))
    assert.equal(createResult.status, 1, outputOf(createResult))
    assert.equal(readFileSync(fixture.output, 'utf8'), 'sentinel')
    rmSync(fixture.output)
    assertSuccess(runCli('create', createArguments(fixture, variant)))
    writeFileSync(fixture.canonicalOutput, 'sentinel', 'utf8')
    const verifyResult = runCli('verify', verifyArguments(fixture, variant))
    assert.equal(verifyResult.status, 1, outputOf(verifyResult))
    assert.equal(readFileSync(fixture.canonicalOutput, 'utf8'), 'sentinel')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
