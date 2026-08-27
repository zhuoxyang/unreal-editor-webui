import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ue-runner-recovery-'))
  const scripts = join(root, 'scripts')
  const localAppData = join(root, 'profile', 'AppData', 'Local')
  const external = join(root, 'external')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(external, { recursive: true })
  copyFileSync(join(ROOT, 'scripts', 'setup-ue-runner.ps1'), join(scripts, 'setup-ue-runner.ps1'))
  copyFileSync(
    join(ROOT, 'scripts', 'remove-ue-runner-registration.ps1'),
    join(scripts, 'remove-ue-runner-registration.ps1'),
  )
  writeFileSync(
    join(scripts, 'test-interactive-runner-session.ps1'),
    '[ordered]@{schemaVersion=1;standardUser=$true;activeConsole=$true;inputDesktop=$true;profileLoaded=$true} | ConvertTo-Json -Compress\n',
    'utf8',
  )
  return {
    root,
    scripts,
    localAppData,
    external,
    runnerBase: join(localAppData, 'UnrealEditorWebUI', 'actions-runners'),
  }
}

function removeFixture(fixture) {
  const possibleLinks = [
    join(fixture.runnerBase, 'build-ue54', 'unsafe-link'),
    join(fixture.runnerBase, 'build-ue54', 'UEWebUIRunnerBootstrap.json'),
  ]
  for (const possibleLink of possibleLinks) {
    if (existsSync(possibleLink) && lstatSync(possibleLink).isSymbolicLink()) unlinkSync(possibleLink)
  }
  rmSync(fixture.root, { recursive: true, force: true })
}

function runWrapper(fixture, source) {
  const wrapper = join(fixture.root, `wrapper-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
  writeFileSync(wrapper, source, 'utf8')
  return spawnSync(
    POWERSHELL,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
    { encoding: 'utf8', windowsHide: true },
  )
}

function runSetup(fixture, { injectReparse = false } = {}) {
  const reparseInjection = injectReparse
    ? `New-Item -ItemType Junction -Path (Join-Path (Split-Path -Parent $OutFile) 'unsafe-link') -Target ${psQuote(fixture.external)} -ErrorAction Stop | Out-Null`
    : ''
  return runWrapper(
    fixture,
    `$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(fixture.localAppData)}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    ${reparseInjection}
    throw 'injected download failure'
}
try {
    & ${psQuote(join(fixture.scripts, 'setup-ue-runner.ps1'))} -RepoUrl 'https://github.com/example/example' -Variant ue54 -Wave build -DedicatedRunnerAccount
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 23
}
`,
  )
}

function runnerRoot(fixture, leaf = 'build-ue54') {
  return join(fixture.runnerBase, leaf)
}

function writeBootstrap(target, overrides = {}) {
  const document = {
    schemaVersion: 2,
    variant: 'ue54',
    wave: 'build',
    state: 'registration-attempted',
    ephemeral: true,
    ...overrides,
  }
  writeFileSync(join(target, 'UEWebUIRunnerBootstrap.json'), `${JSON.stringify(document)}\n`, 'utf8')
}

function runExactCleanup(fixture, { confirm = true } = {}) {
  const confirmation = confirm ? ' -GitHubRegistrationRemoved' : ''
  return runWrapper(
    fixture,
    `$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(fixture.localAppData)}
try {
    & ${psQuote(join(fixture.scripts, 'remove-ue-runner-registration.ps1'))} -Variant ue54 -Wave build${confirmation}
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 23
}
`,
  )
}

test('pre-registration download failure removes only the newly created exact root', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const sentinel = join(fixture.localAppData, 'unrelated-sentinel.txt')
  writeFileSync(sentinel, 'keep', 'utf8')
  try {
    const result = runSetup(fixture)
    assert.equal(result.status, 23, result.stderr)
    assert.match(result.stderr, /injected download failure/u)
    assert.equal(existsSync(runnerRoot(fixture)), false, result.stderr)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  } finally {
    removeFixture(fixture)
  }
})

test('setup never removes a pre-existing exact root', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const target = runnerRoot(fixture)
  const sentinel = join(target, 'pre-existing.txt')
  mkdirSync(target, { recursive: true })
  writeFileSync(sentinel, 'keep', 'utf8')
  try {
    const result = runSetup(fixture)
    assert.equal(result.status, 23, result.stderr)
    assert.match(result.stderr, /already exists/u)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  } finally {
    removeFixture(fixture)
  }
})

test('reparse injection blocks rollback and preserves the external target', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const externalSentinel = join(fixture.external, 'outside.txt')
  writeFileSync(externalSentinel, 'keep', 'utf8')
  try {
    const result = runSetup(fixture, { injectReparse: true })
    assert.equal(result.status, 23, result.stderr)
    assert.match(result.stderr, /Runner setup failed and its pre-registration rollback was unsafe or incomplete/u)
    assert.match(result.stderr, /injected download failure/u)
    assert.match(result.stderr, /reparse point/u)
    assert.equal(existsSync(runnerRoot(fixture)), true)
    assert.equal(readFileSync(externalSentinel, 'utf8'), 'keep')
  } finally {
    removeFixture(fixture)
  }
})

test('exact cleanup requires explicit GitHub registration confirmation', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const target = runnerRoot(fixture)
  mkdirSync(target, { recursive: true })
  writeBootstrap(target)
  try {
    const result = runExactCleanup(fixture, { confirm: false })
    assert.equal(result.status, 23, result.stderr)
    assert.match(result.stderr, /Confirm that the exact ephemeral registration/u)
    assert.equal(existsSync(target), true)
  } finally {
    removeFixture(fixture)
  }
})

test('exact cleanup rejects missing and mismatched recovery identities', { skip: process.platform !== 'win32' }, async (context) => {
  const cases = [
    ['missing bootstrap', null, /no recovery identity/u],
    ['legacy schema', { schemaVersion: 1 }, /invalid recovery identity/u],
    ['wrong variant', { variant: 'ue55' }, /invalid recovery identity/u],
    ['unknown state', { state: 'unknown' }, /invalid recovery identity/u],
  ]
  for (const [name, overrides, expectedError] of cases) {
    await context.test(name, () => {
      const fixture = makeFixture()
      const target = runnerRoot(fixture)
      mkdirSync(target, { recursive: true })
      if (overrides) writeBootstrap(target, overrides)
      try {
        const result = runExactCleanup(fixture)
        assert.equal(result.status, 23, result.stderr)
        assert.match(result.stderr, expectedError)
        assert.equal(existsSync(target), true)
      } finally {
        removeFixture(fixture)
      }
    })
  }
})

test('exact cleanup rejects a reparse-point bootstrap path', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const target = runnerRoot(fixture)
  const externalBootstrap = join(fixture.external, 'bootstrap-directory')
  mkdirSync(target, { recursive: true })
  mkdirSync(externalBootstrap, { recursive: true })
  writeFileSync(join(externalBootstrap, 'outside.txt'), 'keep', 'utf8')
  const link = join(target, 'UEWebUIRunnerBootstrap.json')
  const linkResult = runWrapper(
    fixture,
    `New-Item -ItemType Junction -Path ${psQuote(link)} -Target ${psQuote(externalBootstrap)} -ErrorAction Stop | Out-Null`,
  )
  assert.equal(linkResult.status, 0, linkResult.stderr)
  try {
    const result = runExactCleanup(fixture)
    assert.equal(result.status, 23, result.stderr)
    assert.match(result.stderr, /reparse point/u)
    assert.equal(readFileSync(join(externalBootstrap, 'outside.txt'), 'utf8'), 'keep')
  } finally {
    removeFixture(fixture)
  }
})

test('confirmed exact cleanup removes one identity-matched root and preserves siblings', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture()
  const target = runnerRoot(fixture)
  const sibling = runnerRoot(fixture, 'build-ue55')
  mkdirSync(target, { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeBootstrap(target)
  writeFileSync(join(sibling, 'keep.txt'), 'keep', 'utf8')
  try {
    const result = runExactCleanup(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(target), false)
    assert.equal(readFileSync(join(sibling, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    removeFixture(fixture)
  }
})
