import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VALIDATOR = join(REPOSITORY_ROOT, 'scripts', 'validate-tool-pack.py')
const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'ue-tool-packs')
const CONTENT_FIXTURE = join(FIXTURE_ROOT, 'AssetToolsFixture')
const CODE_FIXTURE = join(FIXTURE_ROOT, 'ExistingCodeToolPackFixture')

function runValidator(pluginDirectories, format = 'json') {
  const args = [VALIDATOR, '--format', format]
  for (const pluginDirectory of pluginDirectories) {
    args.push('--plugin-dir', pluginDirectory)
  }
  return spawnSync('python', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function assertSucceeded(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 0, output)
}

test('offline Tool Pack validator emits deterministic privacy-safe JSON', () => {
  const first = runValidator([CODE_FIXTURE, CONTENT_FIXTURE])
  const second = runValidator([CONTENT_FIXTURE, CODE_FIXTURE])
  assertSucceeded(first)
  assertSucceeded(second)
  assert.equal(first.stdout, second.stdout)
  assert.doesNotMatch(first.stdout, new RegExp(REPOSITORY_ROOT.replaceAll('\\', '\\\\'), 'iu'))

  const document = JSON.parse(first.stdout)
  assert.deepEqual(document, {
    issues: [],
    packs: [
      {
        commandNamespace: 'fixture.asset',
        packId: 'com.openai.fixture.asset-tools',
        pluginName: 'AssetToolsFixture',
        pluginVersion: '1.0.0',
        pythonPackage: 'ue_webui_asset_tools_fixture',
        requiredCoreApi: 1,
      },
      {
        commandNamespace: 'fixture.existing_code',
        packId: 'com.openai.fixture.existing-code',
        pluginName: 'ExistingCodeToolPackFixture',
        pluginVersion: '2.4.1',
        pythonPackage: 'ue_webui_existing_code_fixture',
        requiredCoreApi: 1,
      },
    ],
    schemaVersion: 1,
    valid: true,
  })

  const human = runValidator([CONTENT_FIXTURE], 'human')
  assertSucceeded(human)
  assert.match(human.stdout, /OK AssetToolsFixture/u)
  assert.match(human.stdout, /Validated 1 Tool Pack\(s\)\./u)
  assert.doesNotMatch(human.stdout, /[A-Z]:\\/iu)
})

test('offline Tool Pack validator reports every side of a conflict with stable codes', () => {
  const root = mkdtempSync(join(tmpdir(), 'unreal webui validator conflicts-'))
  const left = join(root, 'left')
  const right = join(root, 'right')
  cpSync(CONTENT_FIXTURE, left, { recursive: true })
  cpSync(join(FIXTURE_ROOT, 'LevelToolsFixture'), right, { recursive: true })
  try {
    const leftManifestPath = join(
      left,
      'Content',
      'UnrealEditorWebUI',
      'ToolPack.json',
    )
    const rightManifestPath = join(
      right,
      'Content',
      'UnrealEditorWebUI',
      'ToolPack.json',
    )
    const leftManifest = JSON.parse(readFileSync(leftManifestPath, 'utf8'))
    const rightManifest = JSON.parse(readFileSync(rightManifestPath, 'utf8'))
    rightManifest.id = leftManifest.id
    writeFileSync(rightManifestPath, `${JSON.stringify(rightManifest, null, 2)}\n`, 'utf8')

    const result = runValidator([right, left])
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, new RegExp(root.replaceAll('\\', '\\\\'), 'iu'))
    const document = JSON.parse(result.stdout)
    assert.equal(document.valid, false)
    assert.deepEqual(
      document.issues.map((issue) => issue.reasonCode),
      ['pack_id_conflict', 'pack_id_conflict'],
    )
    assert.deepEqual(
      document.issues.map((issue) => issue.pluginName),
      ['AssetToolsFixture', 'LevelToolsFixture'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
