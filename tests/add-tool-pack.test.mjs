import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADD_TOOL_PACK = join(REPOSITORY_ROOT, 'scripts', 'add-tool-pack.ps1')
const BUSINESS_PLUGIN_FIXTURE = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'ue-tool-packs',
  'ExistingBusinessPluginFixture',
)
const DEFAULT_ID = 'com.studio.existing-business'
const DEFAULT_NAMESPACE = 'studio.business'
const DEFAULT_PACKAGE = 'ue_webui_toolpack_existing_business_plugin_fixture'

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

function runAddToolPack({
  pluginDirectory,
  id = DEFAULT_ID,
  commandNamespace = DEFAULT_NAMESPACE,
  whatIf = false,
}) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ADD_TOOL_PACK,
    '-PluginDirectory',
    pluginDirectory,
    '-Id',
    id,
    '-CommandNamespace',
    commandNamespace,
  ]
  if (whatIf) args.push('-WhatIf')
  return spawnSync(powershellExecutable, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function assertSucceeded(result) {
  const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 0, output)
}

function copyBusinessPlugin(root) {
  const pluginDirectory = join(root, 'ExistingBusinessPluginFixture')
  cpSync(BUSINESS_PLUGIN_FIXTURE, pluginDirectory, { recursive: true })
  return pluginDirectory
}

function snapshotTree(root) {
  const snapshot = []
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const pathLabel = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        snapshot.push('d:' + pathLabel)
        visit(path)
      } else if (entry.isFile()) {
        snapshot.push('f:' + pathLabel + ':' + readFileSync(path).toString('base64'))
      } else {
        snapshot.push('o:' + pathLabel)
      }
    }
  }
  visit(root)
  return snapshot
}

function withoutToolPackDescriptorChanges(descriptor) {
  const copy = structuredClone(descriptor)
  delete copy.CanContainContent
  if (Array.isArray(copy.Plugins)) {
    copy.Plugins = copy.Plugins.filter(
      (dependency) =>
        typeof dependency?.Name !== 'string'
        || dependency.Name.toLowerCase() !== 'unrealeditorwebui',
    )
  }
  return copy
}

function assertGeneratedPayload(pluginDirectory, expected = {}) {
  const manifest = readJson(
    join(pluginDirectory, 'Content', 'UnrealEditorWebUI', 'ToolPack.json'),
  )
  assert.deepEqual(manifest, {
    schemaVersion: 2,
    id: expected.id ?? DEFAULT_ID,
    requiredCoreApi: 1,
    pythonPackage: expected.pythonPackage ?? DEFAULT_PACKAGE,
    commandNamespace: expected.commandNamespace ?? DEFAULT_NAMESPACE,
    entryModules: ['commands'],
    dependencyPolicy: {
      purePython: { mode: 'none', treeSha256: null },
      native: { mode: 'none' },
    },
  })
  assert.deepEqual(Object.keys(manifest).sort(), [
    'commandNamespace',
    'dependencyPolicy',
    'entryModules',
    'id',
    'pythonPackage',
    'requiredCoreApi',
    'schemaVersion',
  ])

  const packageDirectory = join(
    pluginDirectory,
    'Content',
    'Python',
    manifest.pythonPackage,
  )
  assert.ok(existsSync(join(packageDirectory, '__init__.py')))
  const commandsSource = readFileSync(join(packageDirectory, 'commands.py'), 'utf8')
  assert.match(commandsSource, /from unreal_editor_webui_sdk import command/u)
  assert.match(
    commandsSource,
    new RegExp('"' + manifest.commandNamespace.replaceAll('.', '\\.') + '\\.ping"', 'u'),
  )
}

test(
  'PowerShell adds a Tool Pack to an existing code plugin without changing unrelated descriptor semantics',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui existing code plugin-'))
    try {
      const pluginDirectory = copyBusinessPlugin(root)
      const descriptorPath = join(
        pluginDirectory,
        'ExistingBusinessPluginFixture.uplugin',
      )
      const before = readJson(descriptorPath)
      const result = runAddToolPack({ pluginDirectory })
      assertSucceeded(result)
      assert.match(result.stdout, /Added Tool Pack/u)

      const after = readJson(descriptorPath)
      assert.equal(after.CanContainContent, true)
      assert.deepEqual(
        withoutToolPackDescriptorChanges(after),
        withoutToolPackDescriptorChanges(before),
      )
      assert.deepEqual(after.Modules, before.Modules)
      assert.deepEqual(after.SupportedTargetPlatforms, ['Win64'])
      assert.deepEqual(
        after.Plugins.filter((dependency) => dependency.Name === 'UnrealEditorWebUI'),
        [{ Name: 'UnrealEditorWebUI', Enabled: true }],
      )
      assertGeneratedPayload(pluginDirectory)
      assert.deepEqual(
        readdirSync(pluginDirectory).filter((name) => name.includes('.add-tool-pack-')),
        [],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell supports content-only plugins and normalizes one existing core dependency',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui existing content plugin-'))
    const pluginDirectory = join(root, 'ExistingContentTools')
    mkdirSync(pluginDirectory)
    const descriptorPath = join(pluginDirectory, 'ExistingContentTools.uplugin')
    const unrelatedDependency = { Name: 'PythonScriptPlugin', Enabled: true }
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        FileVersion: 3,
        Version: 9,
        VersionName: '9.1.0',
        FriendlyName: 'Existing Content Tools',
        CanContainContent: false,
        NoCode: true,
        Installed: false,
        Plugins: [
          unrelatedDependency,
          { Name: 'unrealeditorwebui', Enabled: false, Optional: true },
        ],
      }, null, 2) + '\n',
      'utf8',
    )

    try {
      const result = runAddToolPack({
        pluginDirectory,
        id: 'com.studio.existing-content',
        commandNamespace: 'studio.content',
      })
      assertSucceeded(result)
      const descriptor = readJson(descriptorPath)
      assert.equal(descriptor.CanContainContent, true)
      assert.equal(descriptor.NoCode, true)
      assert.equal(descriptor.Modules, undefined)
      assert.deepEqual(descriptor.Plugins[0], unrelatedDependency)
      assert.deepEqual(descriptor.Plugins[1], {
        Name: 'UnrealEditorWebUI',
        Enabled: true,
        Optional: true,
      })
      assert.equal(
        descriptor.Plugins.filter(
          (dependency) => dependency.Name.toLowerCase() === 'unrealeditorwebui',
        ).length,
        1,
      )
      assertGeneratedPayload(pluginDirectory, {
        id: 'com.studio.existing-content',
        commandNamespace: 'studio.content',
        pythonPackage: 'ue_webui_toolpack_existing_content_tools',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell WhatIf validates the operation without changing the plugin',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack whatif-'))
    try {
      const pluginDirectory = copyBusinessPlugin(root)
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory, whatIf: true })
      assertSucceeded(result)
      assert.match(result.stdout, /Would add Tool Pack/u)
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell reports a precise conflict on re-run and never overwrites generated files',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack rerun-'))
    try {
      const pluginDirectory = copyBusinessPlugin(root)
      assertSucceeded(runAddToolPack({ pluginDirectory }))
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /Refusing to overwrite existing Tool Pack manifest/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell refuses an existing generated Python package before changing the descriptor',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack package collision-'))
    try {
      const pluginDirectory = copyBusinessPlugin(root)
      mkdirSync(
        join(pluginDirectory, 'Content', 'Python', DEFAULT_PACKAGE),
        { recursive: true },
      )
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /Refusing to overwrite existing Tool Pack Python package/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell rejects malformed or duplicate JSON and duplicate core dependencies without writing',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')

    const duplicateJsonRoot = mkdtempSync(join(tmpdir(), 'unreal webui duplicate plugin json-'))
    try {
      const pluginDirectory = copyBusinessPlugin(duplicateJsonRoot)
      const descriptorPath = join(
        pluginDirectory,
        'ExistingBusinessPluginFixture.uplugin',
      )
      writeFileSync(
        descriptorPath,
        '{"FileVersion":3,"Modules":[],"\\u004dodules":[]}\n',
        'utf8',
      )
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /duplicate object key "Modules"/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(duplicateJsonRoot, { recursive: true, force: true })
    }

    const malformedJsonRoot = mkdtempSync(join(tmpdir(), 'unreal webui malformed plugin json-'))
    try {
      const pluginDirectory = copyBusinessPlugin(malformedJsonRoot)
      const descriptorPath = join(
        pluginDirectory,
        'ExistingBusinessPluginFixture.uplugin',
      )
      writeFileSync(descriptorPath, '{"FileVersion":3,"Modules":[]\n', 'utf8')
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /not valid strict JSON/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(malformedJsonRoot, { recursive: true, force: true })
    }

    const duplicateDependencyRoot = mkdtempSync(
      join(tmpdir(), 'unreal webui duplicate core dependency-'),
    )
    try {
      const pluginDirectory = copyBusinessPlugin(duplicateDependencyRoot)
      const descriptorPath = join(
        pluginDirectory,
        'ExistingBusinessPluginFixture.uplugin',
      )
      const descriptor = readJson(descriptorPath)
      descriptor.Plugins.push(
        { Name: 'UnrealEditorWebUI', Enabled: true },
        { Name: 'unrealeditorwebui', Enabled: false },
      )
      writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n', 'utf8')
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /duplicate UnrealEditorWebUI dependencies/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(duplicateDependencyRoot, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell rejects invalid identifiers and multiple root descriptors before writing',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    for (const invalidInput of [
      { id: '../com.studio.tools' },
      { id: 'Com.Studio.Tools' },
      { commandNamespace: '../studio.tools' },
      { commandNamespace: 'Studio.tools' },
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack invalid-'))
      try {
        const pluginDirectory = copyBusinessPlugin(root)
        const before = snapshotTree(pluginDirectory)
        const result = runAddToolPack({ pluginDirectory, ...invalidInput })
        assert.equal(result.error, undefined)
        assert.notEqual(result.status, 0)
        assert.deepEqual(snapshotTree(pluginDirectory), before)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack descriptors-'))
    try {
      const pluginDirectory = copyBusinessPlugin(root)
      writeFileSync(join(pluginDirectory, 'Second.uplugin'), '{"FileVersion":3}\n', 'utf8')
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /exactly one regular root \.uplugin descriptor/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'PowerShell refuses a reparse-point plugin directory without changing its target',
  { skip: powershellSkip },
  (t) => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    const root = mkdtempSync(join(tmpdir(), 'unreal webui add tool pack reparse-'))
    const realRoot = join(root, 'real')
    mkdirSync(realRoot)
    const pluginDirectory = copyBusinessPlugin(realRoot)
    const linkPath = join(root, 'linked-plugin')
    try {
      try {
        symlinkSync(
          pluginDirectory,
          linkPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } catch (error) {
        t.skip('Directory links are unavailable on this host: ' + error.message)
        return
      }
      const before = snapshotTree(pluginDirectory)
      const result = runAddToolPack({ pluginDirectory: linkPath })
      assert.equal(result.error, undefined)
      assert.notEqual(result.status, 0)
      assert.match(
        (result.stdout ?? '') + (result.stderr ?? ''),
        /reparse point or symbolic link/u,
      )
      assert.deepEqual(snapshotTree(pluginDirectory), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
