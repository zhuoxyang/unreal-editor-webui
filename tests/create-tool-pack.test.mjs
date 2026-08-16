import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CREATE_TOOL_PACK = join(REPOSITORY_ROOT, 'scripts', 'create-tool-pack.ps1')
const EXAMPLE_TOOL_PACK = join(
  REPOSITORY_ROOT,
  'examples',
  'tool-packs',
  'ExampleAssetTools',
)

function commandAvailable(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

const powershellExecutable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const powershellAvailable = commandAvailable(powershellExecutable, [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'exit 0',
])
const powershellSkip =
  !powershellAvailable && process.env.CI !== 'true' ? 'PowerShell is unavailable locally' : false

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
}

function runCreateToolPack({
  outputDirectory,
  name = 'StudioAssetTools',
  id = 'com.studio.asset-tools',
  commandNamespace = 'studio.assets',
  environment = process.env,
}) {
  return spawnSync(
    powershellExecutable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      CREATE_TOOL_PACK,
      '-Name',
      name,
      '-Id',
      id,
      '-CommandNamespace',
      commandNamespace,
      '-OutputDirectory',
      outputDirectory,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    },
  )
}

function assertSucceeded(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 0, output)
}

function assertNoPrivateStagingDirectories(outputDirectory) {
  assert.deepEqual(
    readdirSync(outputDirectory).filter((name) => name.startsWith('.create-tool-pack-')),
    [],
  )
}

function assertCoreDependency(descriptor) {
  assert.deepEqual(descriptor.Plugins, [{ Name: 'UnrealEditorWebUI', Enabled: true }])
  assert.equal(descriptor.CanContainContent, true)
  assert.equal(descriptor.NoCode, true)
  assert.equal(descriptor.Modules, undefined)
}

function assertClosedManifest(manifest, expected) {
  assert.deepEqual(Object.keys(manifest).sort(), [
    'commandNamespace',
    'id',
    'pythonPackage',
    'requiredCoreApi',
    'schemaVersion',
  ])
  assert.deepEqual(manifest, expected)
}

test('the repository includes a real content-only example Tool Pack', () => {
  const descriptor = readJson(join(EXAMPLE_TOOL_PACK, 'ExampleAssetTools.uplugin'))
  assert.equal(descriptor.Version, 1)
  assert.equal(descriptor.VersionName, '1.0.0')
  assertCoreDependency(descriptor)

  const manifest = readJson(
    join(EXAMPLE_TOOL_PACK, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
  )
  assertClosedManifest(manifest, {
    schemaVersion: 1,
    id: 'com.example.asset-tools',
    requiredCoreApi: 1,
    pythonPackage: 'example_asset_tools',
    commandNamespace: 'example.assets',
  })

  const packageDirectory = join(
    EXAMPLE_TOOL_PACK,
    'Content',
    'Python',
    manifest.pythonPackage,
  )
  assert.ok(existsSync(join(packageDirectory, '__init__.py')))
  const commandsSource = readFileSync(join(packageDirectory, 'commands.py'), 'utf8')
  assert.match(commandsSource, /from unreal_editor_webui_sdk import command/u)
  assert.match(commandsSource, /@command\(\s*"example\.assets\./u)
})

test(
  'PowerShell scaffolds a safe content-only Tool Pack with one core dependency',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui tool pack-'))
    try {
      const environment = { ...process.env }
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === 'os') delete environment[key]
      }
      const outputDirectoryWithoutTrailingSeparator =
        process.platform === 'win32'
          ? `${root[0].toLowerCase()}${root.slice(1)}`
          : root
      const outputDirectory = `${outputDirectoryWithoutTrailingSeparator}${sep}`
      const result = runCreateToolPack({ outputDirectory, environment })
      assertSucceeded(result)

      const targetDirectory = join(root, 'StudioAssetTools')
      assert.equal(
        realpathSync.native(result.stdout.trim()).toLowerCase(),
        realpathSync.native(targetDirectory).toLowerCase(),
      )
      assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1)

      const descriptor = readJson(join(targetDirectory, 'StudioAssetTools.uplugin'))
      assert.equal(descriptor.Version, 1)
      assert.equal(descriptor.VersionName, '1.0.0')
      assertCoreDependency(descriptor)

      const manifest = readJson(
        join(targetDirectory, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
      )
      assertClosedManifest(manifest, {
        schemaVersion: 1,
        id: 'com.studio.asset-tools',
        requiredCoreApi: 1,
        pythonPackage: 'ue_webui_toolpack_studio_asset_tools',
        commandNamespace: 'studio.assets',
      })

      const packageDirectory = join(
        targetDirectory,
        'Content',
        'Python',
        manifest.pythonPackage,
      )
      assert.ok(existsSync(join(packageDirectory, '__init__.py')))
      const commandsSource = readFileSync(join(packageDirectory, 'commands.py'), 'utf8')
      assert.match(commandsSource, /from unreal_editor_webui_sdk import command/u)
      assert.match(commandsSource, /"studio\.assets\.ping"/u)
      assertNoPrivateStagingDirectories(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell refuses to overwrite an existing Tool Pack path',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui tool pack overwrite-'))
    const targetDirectory = join(root, 'StudioAssetTools')
    const sentinelPath = join(targetDirectory, 'keep.txt')
    mkdirSync(targetDirectory)
    writeFileSync(sentinelPath, 'keep me\n', 'utf8')
    try {
      const result = runCreateToolPack({ outputDirectory: root })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.equal(readFileSync(sentinelPath, 'utf8'), 'keep me\n')
      assert.deepEqual(readdirSync(targetDirectory), ['keep.txt'])
      assertNoPrivateStagingDirectories(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell rejects unsafe names and path traversal before writing',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const parent = mkdtempSync(join(tmpdir(), 'unreal webui tool pack escape-'))
    const outputDirectory = join(parent, 'output')
    mkdirSync(outputDirectory)
    const invalidNames = [
      '../EscapedToolPack',
      '..\\EscapedToolPack',
      'lowercaseToolPack',
      'Bad-ToolPack',
      'Bad_ToolPack',
      'CON',
      'UnrealEditorWebUI',
      'UNREALEDITORWEBUI',
      'A',
      'StudioTools\n',
    ]
    try {
      for (const name of invalidNames) {
        const result = runCreateToolPack({ outputDirectory, name })
        assert.equal(result.error, undefined)
        assert.notEqual(result.status, 0, `unsafe name unexpectedly succeeded: ${name}`)
      }
      assert.equal(existsSync(join(parent, 'EscapedToolPack')), false)
      assert.deepEqual(readdirSync(outputDirectory), [])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell rejects unsafe manifest identifiers before writing',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const invalidInputs = [
      { id: '../com.studio.tools' },
      { id: 'Com.Studio.Tools' },
      { id: 'single' },
      { id: 'com.studio.tools\n' },
      { commandNamespace: '../studio.assets' },
      { commandNamespace: 'Studio.assets' },
      { commandNamespace: 'studio-assets' },
      { commandNamespace: 'studio.assets\n' },
    ]

    for (const invalidInput of invalidInputs) {
      const root = mkdtempSync(join(tmpdir(), 'unreal webui tool pack identifier-'))
      try {
        const result = runCreateToolPack({ outputDirectory: root, ...invalidInput })
        assert.equal(result.error, undefined)
        assert.notEqual(result.status, 0)
        assert.deepEqual(readdirSync(root), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  },
)
