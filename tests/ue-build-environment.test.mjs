import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  collectUbtBuildEnvironment,
  EXPECTED_JOB_KEY,
  EXPECTED_JOB_NAME,
  EXPECTED_PACKAGE_ARTIFACT_NAME,
  EXPECTED_WORKFLOW_NAME,
  EXPECTED_WORKFLOW_PATH,
} from '../scripts/ue-build-environment.mjs'
import { requireReleaseVariant } from '../scripts/ue-release-variants.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRIPT_PATH = join(REPOSITORY_ROOT, 'scripts', 'ue-build-environment.mjs')
const SOURCE_COMMIT = 'a'.repeat(40)
const PACKAGE_DIGEST = `sha256:${'b'.repeat(64)}`
const REPOSITORY = 'zhuoxyang/unreal-editor-webui'
const RUN_ID = '30771833666'
const RUN_ATTEMPT = '2'
const PACKAGE_ARTIFACT_ID = '987654321'
const WINDOWS_SDK_VERSION = '10.0.22621.0'
const VARIANT = requireReleaseVariant('ue58')

const VS2022_TOOLCHAIN_ROOT =
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207'
const VS2026_TOOLCHAIN_ROOT =
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Tools\\MSVC\\14.50.35717'
const WINDOWS_SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10'

function buildVersion(overrides = {}) {
  return {
    MajorVersion: 5,
    MinorVersion: 8,
    PatchVersion: VARIANT.engine.patchVersion,
    Changelist: VARIANT.engine.changelist,
    CompatibleChangelist: VARIANT.engine.compatibleChangelist,
    IsLicenseeVersion: 0,
    IsPromotedBuild: 1,
    BranchName: '++UE5+Release-5.8',
    ...overrides,
  }
}

function sourceManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceCommit: SOURCE_COMMIT,
    buildToolchain: {
      nodeVersion: process.versions.node,
      nodeArchitecture: 'x64',
      npmVersion: '11.16.0',
    },
    files: [
      {
        path: 'Web/dist/index.html',
        sha256: 'c'.repeat(64),
      },
    ],
    ...overrides,
  }
}

function ubaLog({
  year = '',
  productVersion = VARIANT.toolchain.productVersion,
  toolchainFamilyVersion = '14.44.35207',
  toolchainRoot = VS2022_TOOLCHAIN_ROOT,
  sdkVersion = WINDOWS_SDK_VERSION,
  sdkRoot = WINDOWS_SDK_ROOT,
  includeUsing = true,
  includeCompiler = true,
  includeResourceCompiler = true,
  repeat = false,
  extraLines = [],
} = {}) {
  const compilerRoot = toolchainRoot.replace(/\\[0-9]+\.[0-9]+\.[0-9]+$/u, `\\${toolchainFamilyVersion}`)
  const usingRoot = compilerRoot
  const usingLine =
    `Using Visual Studio${year ? ` ${year}` : ''} ${productVersion} toolchain ` +
    `(${usingRoot}) and Windows ${sdkVersion} SDK (${sdkRoot}).`
  const compilerLine =
    `Compiler: ${compilerRoot}\\bin\\Hostx64\\x64\\cl.exe`
  const resourceCompilerLine =
    `Resource Compiler: ${sdkRoot}\\bin\\${sdkVersion}\\x64\\rc.exe`
  const lines = [
    '[740/4000] unrelated work before the environment selection',
    ...(includeCompiler ? [compilerLine] : []),
    ...(includeResourceCompiler ? [resourceCompilerLine] : []),
    '[2794/4000] fields are intentionally separated and out of order',
    ...(includeUsing ? [usingLine] : []),
    ...extraLines,
  ]
  if (repeat) {
    if (includeCompiler) lines.push(compilerLine)
    if (includeResourceCompiler) lines.push(resourceCompilerLine)
    if (includeUsing) lines.push(usingLine)
  }
  return `${lines.join('\r\n')}\r\n`
}

function createFixture({ logs = [ubaLog()], referencedIndexes = [0], build = buildVersion(), manifest = sourceManifest() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ue-build-environment-'))
  const logDirectory = join(root, 'automation-logs')
  mkdirSync(logDirectory)
  const logPaths = logs.map((contents, index) => {
    const path = join(logDirectory, `UBA-UnrealEditor-Win64-Development-${index}.txt`)
    writeFileSync(path, contents, 'utf8')
    return path
  })
  const consoleLog = join(root, 'BuildPlugin-console.log')
  writeFileSync(
    consoleLog,
    referencedIndexes
      .map(
        (index) =>
          `Running: dotnet UnrealBuildTool.dll UnrealEditor Win64 Development -log="${logPaths[index]}"`,
      )
      .join('\r\n'),
    'utf8',
  )
  const buildVersionPath = join(root, 'Build.version')
  writeFileSync(buildVersionPath, JSON.stringify(build), 'utf8')
  const sourceManifestPath = join(root, 'SourceManifest.json')
  writeFileSync(sourceManifestPath, JSON.stringify(manifest), 'utf8')
  const editorVersionPath = join(root, 'UnrealEditor.version')
  writeFileSync(
    editorVersionPath,
    JSON.stringify({ ...build, BuildId: VARIANT.engine.buildId }),
    'utf8',
  )
  const packageDirectory = join(root, 'package')
  const binariesDirectory = join(packageDirectory, 'Binaries', 'Win64')
  mkdirSync(binariesDirectory, { recursive: true })
  writeFileSync(
    join(packageDirectory, 'UnrealEditorWebUI.uplugin'),
    JSON.stringify({ Installed: true, EngineVersion: `${VARIANT.engineAssociation}.0` }),
    'utf8',
  )
  writeFileSync(
    join(binariesDirectory, 'UnrealEditor.modules'),
    JSON.stringify({
      BuildId: VARIANT.engine.buildId,
      Modules: { UnrealEditorWebUI: 'UnrealEditor-UnrealEditorWebUI.dll' },
    }),
    'utf8',
  )
  writeFileSync(join(binariesDirectory, 'UnrealEditor-UnrealEditorWebUI.dll'), 'binary')
  return {
    root,
    logDirectory,
    logPaths,
    consoleLog,
    buildVersionPath,
    editorVersionPath,
    sourceManifestPath,
    packageDirectory,
    output: join(root, 'BuildEnvironment.json'),
    canonicalOutput: join(root, 'BuildEnvironment.canonical.json'),
  }
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true })
}

function restoreExactEditorVersion(fixture) {
  writeFileSync(
    fixture.editorVersionPath,
    JSON.stringify({ ...buildVersion(), BuildId: VARIANT.engine.buildId }),
    'utf8',
  )
}

function createArguments(fixture, overrides = {}) {
  const values = {
    'console-log': fixture.consoleLog,
    'log-directory': fixture.logDirectory,
    'build-version': fixture.buildVersionPath,
    'editor-version': fixture.editorVersionPath,
    'source-manifest': fixture.sourceManifestPath,
    'package-directory': fixture.packageDirectory,
    variant: VARIANT.id,
    'embedded-python-version': VARIANT.embeddedPythonVersion,
    'cef-product-version': VARIANT.cefProductVersion,
    'cef-chromium-version': VARIANT.cefChromiumVersion,
    'package-artifact-id': PACKAGE_ARTIFACT_ID,
    'package-artifact-name': EXPECTED_PACKAGE_ARTIFACT_NAME,
    'package-artifact-digest': PACKAGE_DIGEST,
    repository: REPOSITORY,
    commit: SOURCE_COMMIT,
    'run-id': RUN_ID,
    'run-attempt': RUN_ATTEMPT,
    'job-key': EXPECTED_JOB_KEY,
    'job-name': EXPECTED_JOB_NAME,
    'workflow-name': EXPECTED_WORKFLOW_NAME,
    output: fixture.output,
    ...overrides,
  }
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, String(value)])
}

function verifyArguments(fixture, overrides = {}) {
  const values = {
    input: fixture.output,
    repository: REPOSITORY,
    commit: SOURCE_COMMIT,
    'run-id': RUN_ID,
    'run-attempt': RUN_ATTEMPT,
    'job-key': EXPECTED_JOB_KEY,
    'package-artifact-id': PACKAGE_ARTIFACT_ID,
    'package-artifact-name': EXPECTED_PACKAGE_ARTIFACT_NAME,
    'package-artifact-digest': PACKAGE_DIGEST,
    'canonical-output': fixture.canonicalOutput,
    variant: VARIANT.id,
    ...overrides,
  }
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, String(value)])
}

function runCli(command, args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, command, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    windowsHide: true,
  })
}

function outputOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function assertCliSuccess(result) {
  assert.equal(result.error, undefined, outputOf(result))
  assert.equal(result.signal, null, outputOf(result))
  assert.equal(result.status, 0, outputOf(result))
}

function expectedCompiler2022(productVersion = VARIANT.toolchain.productVersion) {
  return {
    kind: 'msvc',
    visualStudioVersion: '2022',
    toolchainFamilyVersion: '14.44.35207',
    compilerProductVersion: productVersion,
    hostArchitecture: 'x64',
    targetArchitecture: 'x64',
  }
}

test('collects the real bare Visual Studio 14.44 UBT tuple from one referenced log', () => {
  const fixture = createFixture()
  try {
    assert.deepEqual(
      collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
      {
        compiler: expectedCompiler2022(),
        windowsSdk: { version: WINDOWS_SDK_VERSION, architecture: 'x64' },
      },
    )
  } finally {
    cleanup(fixture)
  }
})

test('collects UBT references from a PowerShell 5.1 UTF-16LE BOM console log', () => {
  const fixture = createFixture()
  try {
    const consoleText = readFileSync(fixture.consoleLog, 'utf8')
    writeFileSync(
      fixture.consoleLog,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(consoleText, 'utf16le')]),
    )

    assert.deepEqual(
      collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
      {
        compiler: expectedCompiler2022(),
        windowsSdk: { version: WINDOWS_SDK_VERSION, architecture: 'x64' },
      },
    )
  } finally {
    cleanup(fixture)
  }
})

test(
  'Windows containment accepts differently cased paths to the same scoped UBT log',
  { skip: process.platform !== 'win32' ? 'Windows path semantics are required' : false },
  () => {
    const fixture = createFixture()
    try {
      writeFileSync(
        fixture.consoleLog,
        `Running: dotnet UnrealBuildTool.dll -log="${fixture.logPaths[0].toUpperCase()}"`,
        'utf8',
      )
      assert.deepEqual(
        collectUbtBuildEnvironment(
          fixture.consoleLog,
          fixture.logDirectory.toUpperCase(),
        ).compiler,
        expectedCompiler2022(),
      )
    } finally {
      cleanup(fixture)
    }
  },
)

test(
  'Windows containment rejects a scoped junction that resolves to an outside UBT log',
  { skip: process.platform !== 'win32' ? 'Windows junction semantics are required' : false },
  (testContext) => {
    const fixture = createFixture()
    try {
      const outsideDirectory = join(fixture.root, 'outside-automation-logs')
      const outsideLog = join(outsideDirectory, 'UBA-outside.txt')
      const junctionPath = join(fixture.logDirectory, 'outside-junction')
      mkdirSync(outsideDirectory)
      writeFileSync(outsideLog, ubaLog(), 'utf8')
      try {
        symlinkSync(outsideDirectory, junctionPath, 'junction')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'
        testContext.skip(`Windows junction creation is unavailable (${code}).`)
        return
      }

      writeFileSync(
        fixture.consoleLog,
        `Running: dotnet UnrealBuildTool.dll -log="${join(junctionPath, 'UBA-outside.txt')}"`,
        'utf8',
      )
      assert.throws(
        () => collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
        /outside the scoped UBA log set/iu,
      )
    } finally {
      cleanup(fixture)
    }
  },
)

test('infers bare Visual Studio 14.50 as VS 2026 and accepts an explicit matching release', () => {
  for (const year of ['', '2026']) {
    const fixture = createFixture({
      logs: [
        ubaLog({
          year,
          productVersion: '14.50.35723',
          toolchainFamilyVersion: '14.50.35717',
          toolchainRoot: VS2026_TOOLCHAIN_ROOT,
        }),
      ],
    })
    try {
      const selected = collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory)
      assert.equal(selected.compiler.visualStudioVersion, '2026')
      assert.equal(selected.compiler.toolchainFamilyVersion, '14.50.35717')
      assert.equal(selected.compiler.compilerProductVersion, '14.50.35723')
    } finally {
      cleanup(fixture)
    }
  }
})

test('accepts explicit VS 2022 but rejects explicit release/family mismatches', () => {
  const accepted = createFixture({ logs: [ubaLog({ year: '2022' })] })
  try {
    assert.equal(
      collectUbtBuildEnvironment(accepted.consoleLog, accepted.logDirectory).compiler.visualStudioVersion,
      '2022',
    )
  } finally {
    cleanup(accepted)
  }

  for (const [year, productVersion, familyVersion, toolchainRoot] of [
    ['2026', '14.44.35228', '14.44.35207', VS2022_TOOLCHAIN_ROOT],
    ['2022', '14.50.35723', '14.50.35717', VS2026_TOOLCHAIN_ROOT],
  ]) {
    const fixture = createFixture({
      logs: [ubaLog({ year, productVersion, toolchainFamilyVersion: familyVersion, toolchainRoot })],
    })
    try {
      assert.throws(
        () => collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
        /does not match/iu,
      )
    } finally {
      cleanup(fixture)
    }
  }
})

test('requires a complete consistent tuple independently inside every referenced UBT log', () => {
  const fixture = createFixture({
    logs: [
      ubaLog({ includeCompiler: false, includeResourceCompiler: false }),
      ubaLog({ includeUsing: false }),
    ],
    referencedIndexes: [0, 1],
  })
  try {
    assert.throws(
      () => collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
      /missing/iu,
    )
  } finally {
    cleanup(fixture)
  }
})

test('rejects console log references outside the fresh AutomationTool log directory', () => {
  const fixture = createFixture()
  try {
    const outsidePath = join(fixture.root, 'UBA-outside.txt')
    writeFileSync(outsidePath, ubaLog(), 'utf8')
    writeFileSync(
      fixture.consoleLog,
      `Running: dotnet UnrealBuildTool.dll -log="${outsidePath}"`,
      'utf8',
    )
    assert.throws(
      () => collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory),
      /outside the scoped UBA log set/iu,
    )
  } finally {
    cleanup(fixture)
  }
})

test('ignores unreferenced fake UBA logs and unrelated console -log text', () => {
  const fixture = createFixture({
    logs: [
      ubaLog(),
      ubaLog({
        productVersion: '14.50.35723',
        toolchainFamilyVersion: '14.50.35717',
        toolchainRoot: VS2026_TOOLCHAIN_ROOT,
      }),
    ],
    referencedIndexes: [0],
  })
  try {
    writeFileSync(
      fixture.consoleLog,
      `${readFileSync(fixture.consoleLog, 'utf8')}\r\n` +
        `Diagnostic: -log="${fixture.logPaths[1]}"\r\n` +
        `Running: unrelated-tool.exe -log="${fixture.logPaths[1]}"`,
      'utf8',
    )
    assert.deepEqual(
      collectUbtBuildEnvironment(fixture.consoleLog, fixture.logDirectory).compiler,
      expectedCompiler2022(),
    )
  } finally {
    cleanup(fixture)
  }
})

test('accepts repeated identical tuples and rejects conflicts within or across referenced logs', () => {
  const repeated = createFixture({ logs: [ubaLog({ repeat: true }), ubaLog()], referencedIndexes: [0, 1] })
  try {
    assert.deepEqual(
      collectUbtBuildEnvironment(repeated.consoleLog, repeated.logDirectory).compiler,
      expectedCompiler2022(),
    )
  } finally {
    cleanup(repeated)
  }

  const conflictingUsingLine =
    `Using Visual Studio 14.44.35229 toolchain (${VS2022_TOOLCHAIN_ROOT}) ` +
    `and Windows ${WINDOWS_SDK_VERSION} SDK (${WINDOWS_SDK_ROOT}).`
  const within = createFixture({ logs: [ubaLog({ extraLines: [conflictingUsingLine] })] })
  try {
    assert.throws(
      () => collectUbtBuildEnvironment(within.consoleLog, within.logDirectory),
      /conflicting/iu,
    )
  } finally {
    cleanup(within)
  }

  const across = createFixture({
    logs: [
      ubaLog(),
      ubaLog({
        productVersion: '14.50.35723',
        toolchainFamilyVersion: '14.50.35717',
        toolchainRoot: VS2026_TOOLCHAIN_ROOT,
      }),
    ],
    referencedIndexes: [0, 1],
  })
  try {
    assert.throws(
      () => collectUbtBuildEnvironment(across.consoleLog, across.logDirectory),
      /conflicting complete/iu,
    )
  } finally {
    cleanup(across)
  }
})

test('enforces both approved compiler-product version boundaries', () => {
  const cases = [
    [VARIANT.toolchain.productVersion, '14.44.35207', VS2022_TOOLCHAIN_ROOT, true],
    ['14.44.35211', '14.44.35207', VS2022_TOOLCHAIN_ROOT, false],
    ['14.44.35210', '14.44.35207', VS2022_TOOLCHAIN_ROOT, false],
    ['14.45.0', '14.45.0', VS2022_TOOLCHAIN_ROOT, false],
    ['14.50.35723', '14.50.35717', VS2026_TOOLCHAIN_ROOT, false],
    ['14.50.35722', '14.50.35717', VS2026_TOOLCHAIN_ROOT, false],
    ['14.51.0', '14.51.0', VS2026_TOOLCHAIN_ROOT, false],
  ]
  for (const [productVersion, familyVersion, toolchainRoot, accepted] of cases) {
    const fixture = createFixture({
      logs: [ubaLog({ productVersion, toolchainFamilyVersion: familyVersion, toolchainRoot })],
    })
    try {
      const result = runCli('create', createArguments(fixture))
      assert.equal(result.status === 0, accepted, outputOf(result))
    } finally {
      cleanup(fixture)
    }
  }
})

test('create emits a closed canonical v2 document and verify rebuilds the same bytes', () => {
  const fixture = createFixture({
    build: buildVersion({
      MachinePath: 'C:\\Users\\runner\\UE_5.8',
      token: 'must-not-leak',
    }),
    manifest: sourceManifest({
      files: [{ path: 'C:/sensitive/source/path', sha256: 'd'.repeat(64) }],
    }),
  })
  try {
    const createResult = runCli('create', createArguments(fixture))
    assertCliSuccess(createResult)
    const documentText = readFileSync(fixture.output, 'utf8')
    const document = JSON.parse(documentText)

    assert.deepEqual(document, {
      schemaVersion: 2,
      releaseVariant: VARIANT.releaseVariant,
      buildId: VARIANT.engine.buildId,
      repository: REPOSITORY,
      sourceCommit: SOURCE_COMMIT,
      workflow: {
        path: EXPECTED_WORKFLOW_PATH,
        name: EXPECTED_WORKFLOW_NAME,
        runId: Number(RUN_ID),
        runAttempt: Number(RUN_ATTEMPT),
        jobKey: EXPECTED_JOB_KEY,
        jobName: EXPECTED_JOB_NAME,
      },
      unrealEngine: {
        majorVersion: 5,
        minorVersion: 8,
        patchVersion: VARIANT.engine.patchVersion,
        changelist: VARIANT.engine.changelist,
        compatibleChangelist: VARIANT.engine.compatibleChangelist,
        branchName: '++UE5+Release-5.8',
        isLicenseeVersion: false,
        isPromotedBuild: true,
      },
      compiler: expectedCompiler2022(),
      windowsSdk: { version: WINDOWS_SDK_VERSION, architecture: 'x64' },
      frontend: {
        nodeVersion: process.versions.node,
        nodeArchitecture: 'x64',
        npmVersion: '11.16.0',
      },
      runtime: {
        embeddedPythonVersion: VARIANT.embeddedPythonVersion,
        cefProductVersion: VARIANT.cefProductVersion,
        cefChromiumVersion: VARIANT.cefChromiumVersion,
      },
      packageArtifact: {
        artifactId: Number(PACKAGE_ARTIFACT_ID),
        artifactName: EXPECTED_PACKAGE_ARTIFACT_NAME,
        artifactDigest: PACKAGE_DIGEST,
      },
    })
    assert.equal(documentText.endsWith('\n'), true)
    assert.doesNotMatch(documentText, /must-not-leak|sensitive|MachinePath|token|runner/iu)

    const verifyResult = runCli('verify', verifyArguments(fixture))
    assertCliSuccess(verifyResult)
    assert.equal(readFileSync(fixture.canonicalOutput, 'utf8'), documentText)
  } finally {
    cleanup(fixture)
  }
})

test('create and verify preserve the UE zero compatible-changelist sentinel', () => {
  const fixture = createFixture({
    build: buildVersion({
      PatchVersion: 0,
      Changelist: 55116800,
      CompatibleChangelist: 0,
    }),
  })
  try {
    const createResult = runCli('create', createArguments(fixture))
    assertCliSuccess(createResult)
    const documentText = readFileSync(fixture.output, 'utf8')
    const document = JSON.parse(documentText)

    assert.equal(document.unrealEngine.patchVersion, 0)
    assert.equal(document.unrealEngine.changelist, 55116800)
    assert.equal(document.unrealEngine.compatibleChangelist, 0)

    const verifyResult = runCli('verify', verifyArguments(fixture))
    assertCliSuccess(verifyResult)
    assert.equal(readFileSync(fixture.canonicalOutput, 'utf8'), documentText)
  } finally {
    cleanup(fixture)
  }
})

test('create rejects a relationally valid CompatibleChangelist outside the exact variant', () => {
  const fixture = createFixture({
    build: buildVersion({ CompatibleChangelist: VARIANT.engine.changelist }),
  })
  try {
    restoreExactEditorVersion(fixture)
    const result = runCli('create', createArguments(fixture))
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /exact UE58-Win64 build/iu)
  } finally {
    cleanup(fixture)
  }
})

test('create and verify reject a compatible changelist newer than the current changelist', () => {
  const createFixtureValue = createFixture({
    build: buildVersion({ CompatibleChangelist: 56057346 }),
  })
  try {
    restoreExactEditorVersion(createFixtureValue)
    const result = runCli('create', createArguments(createFixtureValue))
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /must be zero or no greater than the UE changelist/iu)
    assert.throws(() => readFileSync(createFixtureValue.output), { code: 'ENOENT' })
  } finally {
    cleanup(createFixtureValue)
  }

  const verifyFixtureValue = createFixture()
  try {
    assertCliSuccess(runCli('create', createArguments(verifyFixtureValue)))
    const document = JSON.parse(readFileSync(verifyFixtureValue.output, 'utf8'))
    document.unrealEngine.compatibleChangelist = document.unrealEngine.changelist + 1
    writeFileSync(verifyFixtureValue.output, JSON.stringify(document), 'utf8')

    const result = runCli('verify', verifyArguments(verifyFixtureValue))
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /must be zero or no greater than the UE changelist/iu)
    assert.throws(() => readFileSync(verifyFixtureValue.canonicalOutput), { code: 'ENOENT' })
  } finally {
    cleanup(verifyFixtureValue)
  }
})

test('verify rejects malformed UE compatible changelists', () => {
  for (const compatibleChangelist of [-1, '0']) {
    const fixture = createFixture({
      build: buildVersion({ CompatibleChangelist: 0 }),
    })
    try {
      assertCliSuccess(runCli('create', createArguments(fixture)))
      const document = JSON.parse(readFileSync(fixture.output, 'utf8'))
      document.unrealEngine.compatibleChangelist = compatibleChangelist
      writeFileSync(fixture.output, JSON.stringify(document), 'utf8')

      const result = runCli('verify', verifyArguments(fixture))
      assert.equal(result.status, 1, outputOf(result))
      assert.match(outputOf(result), /compatible changelist must be a safe non-negative integer/iu)
      assert.throws(() => readFileSync(fixture.canonicalOutput), { code: 'ENOENT' })
    } finally {
      cleanup(fixture)
    }
  }
})

test('create rejects malformed UE compatible changelists', () => {
  for (const compatibleChangelist of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    const fixture = createFixture({
      build: buildVersion({ CompatibleChangelist: compatibleChangelist }),
    })
    try {
      restoreExactEditorVersion(fixture)
      const result = runCli('create', createArguments(fixture))
      assert.equal(result.status, 1, outputOf(result))
      assert.match(outputOf(result), /compatible changelist must be a safe non-negative integer/iu)
      assert.throws(() => readFileSync(fixture.output), { code: 'ENOENT' })
    } finally {
      cleanup(fixture)
    }
  }
})

test('verify rejects unknown fields without echoing injected path or token data', () => {
  const fixture = createFixture()
  try {
    assertCliSuccess(runCli('create', createArguments(fixture)))
    const document = JSON.parse(readFileSync(fixture.output, 'utf8'))
    document.machinePath = 'C:\\Users\\secret-user\\private'
    document.token = 'ultra-secret-token-value'
    writeFileSync(fixture.output, JSON.stringify(document), 'utf8')

    const result = runCli('verify', verifyArguments(fixture))
    const output = outputOf(result)
    assert.equal(result.status, 1, output)
    assert.match(output, /unexpected or missing field/iu)
    assert.doesNotMatch(output, /secret-user|ultra-secret-token-value|machinePath/iu)
    assert.throws(() => readFileSync(fixture.canonicalOutput), { code: 'ENOENT' })
  } finally {
    cleanup(fixture)
  }
})

test('verify fails closed on wrong workflow and package subject bindings', () => {
  const overrides = [
    { repository: 'different-owner/unreal-editor-webui' },
    { commit: 'e'.repeat(40) },
    { 'run-id': '30771833667' },
    { 'run-attempt': '3' },
    { 'job-key': 'different-job' },
    { 'package-artifact-id': '987654322' },
    { 'package-artifact-name': 'UnrealEditorWebUI-Package-UE53' },
    { 'package-artifact-digest': `sha256:${'f'.repeat(64)}` },
  ]
  for (const override of overrides) {
    const fixture = createFixture()
    try {
      assertCliSuccess(runCli('create', createArguments(fixture)))
      const result = runCli('verify', verifyArguments(fixture, override))
      assert.equal(result.status, 1, outputOf(result))
      assert.throws(() => readFileSync(fixture.canonicalOutput), { code: 'ENOENT' })
    } finally {
      cleanup(fixture)
    }
  }
})

test('create and verify refuse to overwrite existing output files', () => {
  const fixture = createFixture()
  try {
    writeFileSync(fixture.output, 'create-sentinel', 'utf8')
    const createResult = runCli('create', createArguments(fixture))
    assert.equal(createResult.status, 1, outputOf(createResult))
    assert.match(outputOf(createResult), /must be fresh/iu)
    assert.equal(readFileSync(fixture.output, 'utf8'), 'create-sentinel')

    rmSync(fixture.output)
    assertCliSuccess(runCli('create', createArguments(fixture)))
    writeFileSync(fixture.canonicalOutput, 'verify-sentinel', 'utf8')
    const verifyResult = runCli('verify', verifyArguments(fixture))
    assert.equal(verifyResult.status, 1, outputOf(verifyResult))
    assert.match(outputOf(verifyResult), /must be fresh/iu)
    assert.equal(readFileSync(fixture.canonicalOutput, 'utf8'), 'verify-sentinel')
  } finally {
    cleanup(fixture)
  }
})

test('create rejects malformed frontend toolchain evidence and non-canonical artifact subjects', () => {
  const manifests = [
    sourceManifest({
      buildToolchain: {
        nodeVersion: process.versions.node,
        nodeArchitecture: 'x64',
        npmVersion: '11.16.0 extra',
      },
    }),
    sourceManifest({
      buildToolchain: {
        nodeVersion: '24.18.0',
        nodeArchitecture: 'x64',
        npmVersion: '11.16.0',
      },
    }),
  ]
  for (const manifest of manifests) {
    const fixture = createFixture({ manifest })
    try {
      const result = runCli('create', createArguments(fixture))
      assert.equal(result.status, 1, outputOf(result))
    } finally {
      cleanup(fixture)
    }
  }

  for (const override of [
    { 'package-artifact-digest': `sha256:${'B'.repeat(64)}` },
    { 'package-artifact-name': 'UnrealEditorWebUI-Package-UE53' },
    { 'run-attempt': '0' },
  ]) {
    const fixture = createFixture()
    try {
      const result = runCli('create', createArguments(fixture, override))
      assert.equal(result.status, 1, outputOf(result))
    } finally {
      cleanup(fixture)
    }
  }
})
