import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MALICIOUS_LOCKFILE = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'npm-lock-registry',
  'malicious-package-lock.json',
)
const OFFICIAL_LOCKFILE = {
  name: 'registry-guard-fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'registry-guard-fixture', version: '1.0.0' },
    'node_modules/example': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      integrity: 'sha512-fixture',
    },
  },
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, 'utf8')
  chmodSync(path, 0o755)
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

function createFixture(lockfile, shellKind) {
  const root = mkdtempSync(join(tmpdir(), 'unreal webui registry guard-'))
  const scriptsDir = join(root, 'scripts')
  const frontendDir = join(root, 'frontend')
  const probeBin = join(root, 'probe-bin')
  mkdirSync(scriptsDir)
  mkdirSync(frontendDir)
  mkdirSync(probeBin)

  for (const scriptName of [
    'package-plugin.ps1',
    'package-plugin.sh',
    'validate-node-version.mjs',
    'validate-npm-lock-registry.mjs',
  ]) {
    copyFileSync(join(REPOSITORY_ROOT, 'scripts', scriptName), join(scriptsDir, scriptName))
  }

  const lockfileContents =
    typeof lockfile === 'string'
      ? readFileSync(lockfile, 'utf8')
      : `${JSON.stringify(lockfile, null, 2)}\n`
  writeFileSync(join(frontendDir, 'package-lock.json'), lockfileContents, 'utf8')
  mkdirSync(join(root, 'Web', 'dist'), { recursive: true })
  writeFileSync(join(root, 'Web', 'dist', 'index.html'), '<!doctype html>\n', 'utf8')
  writeFileSync(join(root, 'LICENSE'), 'fixture license\n', 'utf8')
  writeFileSync(join(root, 'UnrealEditorWebUI.uplugin'), '{}\n', 'utf8')

  const npmProbe = join(root, 'npm-probe.txt')
  const runUatProbe = join(root, 'runuat-probe.txt')
  let runUat
  if (shellKind === 'powershell' && process.platform === 'win32') {
    writeFileSync(
      join(probeBin, 'npm.cmd'),
      '@echo off\r\n>> "%NPM_PROBE%" echo npm %*\r\nif /I "%NPM_PROBE_MODE%"=="succeed" exit /b 0\r\nexit /b 91\r\n',
      'utf8',
    )
    writeFileSync(join(probeBin, 'robocopy.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8')
    runUat = join(probeBin, 'RunUAT.cmd')
    writeFileSync(
      runUat,
      '@echo off\r\n> "%RUNUAT_PROBE%" echo RunUAT %*\r\nexit /b 92\r\n',
      'utf8',
    )
  } else {
    writeExecutable(
      join(probeBin, 'npm'),
      '#!/usr/bin/env sh\nprintf "npm %s\\n" "$*" >> "$NPM_PROBE"\nif [ "${NPM_PROBE_MODE:-fail}" = "succeed" ]; then\n  exit 0\nfi\nexit 91\n',
    )
    writeExecutable(join(probeBin, 'rsync'), '#!/usr/bin/env sh\nexit 0\n')
    writeExecutable(join(probeBin, 'robocopy'), '#!/usr/bin/env sh\nexit 0\n')
    runUat = join(probeBin, 'RunUAT')
    writeExecutable(
      runUat,
      '#!/usr/bin/env sh\nprintf "RunUAT %s\\n" "$*" > "$RUNUAT_PROBE"\nexit 92\n',
    )
  }

  const env = { ...process.env }
  const originalPath = env.PATH ?? env.Path ?? ''
  delete env.Path
  env.PATH = [probeBin, dirname(process.execPath), originalPath].join(delimiter)
  env.NPM_PROBE = npmProbe
  env.NPM_PROBE_MODE = 'fail'
  env.RUNUAT_PROBE = runUatProbe
  env.TEMP = root
  env.TMP = root
  env.TMPDIR = root

  return {
    env,
    initialDirectories: topLevelDirectories(root),
    npmProbe,
    packageDir: join(root, 'package-output'),
    root,
    runUat,
    runUatProbe,
    scriptsDir,
  }
}

function topLevelDirectories(root) {
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
}

function runPackageScript(shellKind, fixture, executable) {
  if (shellKind === 'bash') {
    return spawnSync(
      executable,
      [join(fixture.scriptsDir, 'package-plugin.sh'), fixture.runUat, fixture.packageDir],
      {
        cwd: fixture.root,
        encoding: 'utf8',
        env: fixture.env,
        windowsHide: true,
      },
    )
  }

  return spawnSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(fixture.scriptsDir, 'package-plugin.ps1'),
      '-RunUAT',
      fixture.runUat,
      '-PackageDir',
      fixture.packageDir,
    ],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: fixture.env,
      windowsHide: true,
    },
  )
}

function assertMaliciousLockStopsBeforeCommands(shellKind, executable) {
  const fixture = createFixture(MALICIOUS_LOCKFILE, shellKind)
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 1, output)
    assert.match(output, /npm lockfile registry validation failed/u)
    assert.match(output, /host must be registry\.npmjs\.org/u)
    assert.equal(existsSync(fixture.npmProbe), false, 'npm must not run after guard rejection')
    assert.equal(existsSync(fixture.runUatProbe), false, 'RunUAT must not run after guard rejection')
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

function assertOfficialLockReachesNpmProbe(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, shellKind === 'bash' ? 91 : 1, output)
    assert.match(output, /Validated 1 npm lockfile URL/u)
    assert.equal(existsSync(fixture.npmProbe), true, 'the official lock must reach npm')
    assert.equal(readFileSync(fixture.npmProbe, 'utf8').trim(), 'npm ci')
    assert.equal(existsSync(fixture.runUatProbe), false, 'the failing npm probe must stop before RunUAT')
    unlinkSync(fixture.npmProbe)
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

function assertRunUatFailureCleansStaging(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 92, output)
    assert.deepEqual(
      readFileSync(fixture.npmProbe, 'utf8').trim().split(/\r?\n/u),
      ['npm ci', 'npm run build'],
    )
    assert.match(readFileSync(fixture.runUatProbe, 'utf8'), /^RunUAT BuildPlugin\b/u)
    assert.deepEqual(
      topLevelDirectories(fixture.root),
      fixture.initialDirectories,
      'the staging directory must be removed after RunUAT fails',
    )
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

const windowsGitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
const bashExecutable =
  process.platform === 'win32' ? (existsSync(windowsGitBash) ? windowsGitBash : null) : 'bash'
const bashAvailable =
  bashExecutable !== null && commandAvailable(bashExecutable, ['--version'])
const bashSkip = !bashAvailable && process.env.CI !== 'true' ? 'bash is unavailable locally' : false

test('Bash packaging rejects a malicious registry before npm or RunUAT', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertMaliciousLockStopsBeforeCommands('bash', bashExecutable)
})

test('Bash packaging accepts an official lock before invoking npm', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertOfficialLockReachesNpmProbe('bash', bashExecutable)
})

test('Bash packaging cleans staging when RunUAT fails', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertRunUatFailureCleansStaging('bash', bashExecutable)
})

const powershellExecutable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const powershellAvailable = commandAvailable(powershellExecutable, [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'exit 0',
])
const powershellSkip =
  !powershellAvailable && process.env.CI !== 'true' ? 'PowerShell is unavailable locally' : false

test(
  'PowerShell packaging rejects a malicious registry before npm or RunUAT',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertMaliciousLockStopsBeforeCommands('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging accepts an official lock before invoking npm',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertOfficialLockReachesNpmProbe('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging cleans staging when RunUAT fails',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertRunUatFailureCleansStaging('powershell', powershellExecutable)
  },
)
