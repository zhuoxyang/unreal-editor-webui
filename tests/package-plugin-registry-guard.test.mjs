import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  const packageDir = join(root, 'package-output')
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
      '@echo off\r\n> "%RUNUAT_PROBE%" echo RunUAT %*\r\necho %RUNUAT_STDOUT_SENTINEL%\r\n>&2 echo %RUNUAT_STDERR_SENTINEL%\r\nif /I "%RUNUAT_PROBE_MODE%"=="fail-before-log" exit /b 94\r\nif defined uebp_LogFolder (\r\n  if not "%uebp_LogFolder%"=="%uebp_FinalLogFolder%" exit /b 93\r\n  if not exist "%uebp_LogFolder%" mkdir "%uebp_LogFolder%"\r\n  > "%uebp_LogFolder%\\Log.txt" echo uebp_LogFolder=%uebp_LogFolder%\r\n  >> "%uebp_LogFolder%\\Log.txt" echo uebp_FinalLogFolder=%uebp_FinalLogFolder%\r\n)\r\nif /I "%RUNUAT_PROBE_MODE%"=="succeed" (\r\n  if not exist "%RUNUAT_PACKAGE_DIR%" mkdir "%RUNUAT_PACKAGE_DIR%"\r\n  copy /Y "%RUNUAT_LICENSE_SOURCE%" "%RUNUAT_PACKAGE_DIR%\\LICENSE" >nul\r\n  exit /b 0\r\n)\r\nexit /b 92\r\n',
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
      '#!/usr/bin/env sh\nprintf "RunUAT %s\\n" "$*" > "$RUNUAT_PROBE"\nprintf "%s\\n" "$RUNUAT_STDOUT_SENTINEL"\nprintf "%s\\n" "$RUNUAT_STDERR_SENTINEL" >&2\nif [ "${RUNUAT_PROBE_MODE:-fail}" = "fail-before-log" ]; then\n  exit 94\nfi\nif [ -n "${uebp_LogFolder:-}" ]; then\n  if [ "$uebp_LogFolder" != "${uebp_FinalLogFolder:-}" ]; then\n    exit 93\n  fi\n  mkdir -p "$uebp_LogFolder"\n  printf "uebp_LogFolder=%s\\nuebp_FinalLogFolder=%s\\n" "$uebp_LogFolder" "$uebp_FinalLogFolder" > "$uebp_LogFolder/Log.txt"\nfi\nif [ "${RUNUAT_PROBE_MODE:-fail}" = "succeed" ]; then\n  mkdir -p "$RUNUAT_PACKAGE_DIR"\n  cp "$RUNUAT_LICENSE_SOURCE" "$RUNUAT_PACKAGE_DIR/LICENSE"\n  exit 0\nfi\nexit 92\n',
    )
  }

  const env = { ...process.env }
  const originalPath = env.PATH ?? env.Path ?? ''
  delete env.Path
  env.PATH = [probeBin, dirname(process.execPath), originalPath].join(delimiter)
  env.NPM_PROBE = npmProbe
  env.NPM_PROBE_MODE = 'fail'
  env.RUNUAT_LICENSE_SOURCE = join(root, 'LICENSE')
  env.RUNUAT_PACKAGE_DIR = packageDir
  env.RUNUAT_PROBE = runUatProbe
  env.RUNUAT_PROBE_MODE = 'fail'
  env.RUNUAT_STDERR_SENTINEL = 'current-run-uat-stderr-sentinel'
  env.RUNUAT_STDOUT_SENTINEL = 'current-run-uat-stdout-sentinel'
  env.TEMP = root
  env.TMP = root
  env.TMPDIR = root

  return {
    env,
    initialDirectories: topLevelDirectories(root),
    npmProbe,
    packageDir,
    root,
    runUat,
    runUatProbe,
    scriptsDir,
  }
}

function useScopedAutomationLogs(fixture, runId, runAttempt) {
  for (const name of Object.keys(fixture.env)) {
    if (['uebp_logfolder', 'uebp_finallogfolder'].includes(name.toLowerCase())) {
      delete fixture.env[name]
    }
  }

  const directory = join(
    fixture.root,
    `UnrealEditorWebUI-AutomationToolLogs-${runId}-${runAttempt}`,
  )
  fixture.env.uebp_LogFolder = directory
  fixture.env.uebp_FinalLogFolder = directory
  return directory
}

function createHistoricalLogSentinels(fixture, runId) {
  const appDataRoot = join(fixture.root, 'appdata')
  const appDataSentinel = join(
    appDataRoot,
    'Unreal Engine',
    'AutomationTool',
    'Logs',
    'UE_5.8',
    'global-sentinel.txt',
  )
  const priorAttemptSentinel = join(
    fixture.root,
    `UnrealEditorWebUI-AutomationToolLogs-${runId}-1`,
    'prior-attempt-sentinel.txt',
  )
  mkdirSync(dirname(appDataSentinel), { recursive: true })
  mkdirSync(dirname(priorAttemptSentinel), { recursive: true })
  writeFileSync(appDataSentinel, 'global history\n', 'utf8')
  writeFileSync(priorAttemptSentinel, 'prior attempt\n', 'utf8')
  fixture.env.APPDATA = appDataRoot
  return { appDataSentinel, priorAttemptSentinel }
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

function runPowerShellPackageWithConsoleCapture(fixture, executable, consoleLog) {
  const wrapper = join(fixture.root, 'capture-package-console.ps1')
  writeFileSync(
    wrapper,
    `param(
    [string]$PowerShellExecutable,
    [string]$PackageScript,
    [string]$RunUAT,
    [string]$PackageDir,
    [string]$ConsoleLog
)

$ErrorActionPreference = "Stop"
$PreviousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $PowerShellExecutable -NoProfile -ExecutionPolicy Bypass -File $PackageScript -RunUAT $RunUAT -PackageDir $PackageDir 2>&1 | Tee-Object -FilePath $ConsoleLog
    $PackageExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
}
exit $PackageExitCode
`,
    'utf8',
  )

  return spawnSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      wrapper,
      '-PowerShellExecutable',
      executable,
      '-PackageScript',
      join(fixture.scriptsDir, 'package-plugin.ps1'),
      '-RunUAT',
      fixture.runUat,
      '-PackageDir',
      fixture.packageDir,
      '-ConsoleLog',
      consoleLog,
    ],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: fixture.env,
      windowsHide: true,
    },
  )
}

function readPowerShellLog(path) {
  const contents = readFileSync(path)
  if (contents[0] === 0xff && contents[1] === 0xfe) {
    return contents.subarray(2).toString('utf16le')
  }
  return contents.toString('utf8')
}

function assertScopedRunUatFailureRetainsOnlyCurrentLogs(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const runId = '777'
  const logDirectory = useScopedAutomationLogs(fixture, runId, '2')
  const sentinels = createHistoricalLogSentinels(fixture, runId)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  try {
    const result = runPackageScript('powershell', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 92, output)
    assert.deepEqual(readdirSync(logDirectory), ['Log.txt'])
    const currentLog = readFileSync(join(logDirectory, 'Log.txt'), 'utf8')
    assert.match(currentLog, new RegExp(`uebp_LogFolder=${escapeRegExp(logDirectory)}`, 'u'))
    assert.match(currentLog, new RegExp(`uebp_FinalLogFolder=${escapeRegExp(logDirectory)}`, 'u'))
    assert.equal(existsSync(sentinels.appDataSentinel), true)
    assert.equal(existsSync(sentinels.priorAttemptSentinel), true)
    assert.doesNotMatch(currentLog, /sentinel/u)
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

function assertScopedRunUatSuccessRetainsLogsAndPackage(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const logDirectory = useScopedAutomationLogs(fixture, '888', '1')
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_PROBE_MODE = 'succeed'
  try {
    const result = runPackageScript('powershell', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 0, output)
    assert.equal(existsSync(join(logDirectory, 'Log.txt')), true)
    assert.equal(
      readFileSync(join(fixture.packageDir, 'LICENSE'), 'utf8'),
      readFileSync(join(fixture.root, 'LICENSE'), 'utf8'),
    )
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

function assertEarlyRunUatFailureRetainsConsoleOutput(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const logDirectory = useScopedAutomationLogs(fixture, '999', '3')
  const consoleLog = join(fixture.root, 'UnrealEditorWebUI-BuildPlugin-999-3.log')
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_PROBE_MODE = 'fail-before-log'
  const sentinelId = randomUUID()
  fixture.env.RUNUAT_STDERR_SENTINEL = `current-run-stderr-${sentinelId}`
  fixture.env.RUNUAT_STDOUT_SENTINEL = `current-run-stdout-${sentinelId}`
  try {
    const result = runPowerShellPackageWithConsoleCapture(fixture, executable, consoleLog)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 94, output)
    assert.equal(existsSync(join(logDirectory, 'Log.txt')), false)
    const captured = readPowerShellLog(consoleLog)
    assert.match(captured, new RegExp(fixture.env.RUNUAT_STDOUT_SENTINEL, 'u'))
    assert.match(captured, new RegExp(fixture.env.RUNUAT_STDERR_SENTINEL, 'u'))
  } finally {
    rmSync(fixture.root, { force: true, recursive: true })
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
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

test(
  'PowerShell packaging retains only current scoped AutomationTool logs on failure',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertScopedRunUatFailureRetainsOnlyCurrentLogs(powershellExecutable)
  },
)

test(
  'PowerShell packaging retains scoped logs and the package on success',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertScopedRunUatSuccessRetainsLogsAndPackage(powershellExecutable)
  },
)

test(
  'Windows PowerShell captures output when RunUAT fails before creating its log',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows PowerShell 5.1 and RunUAT.cmd are required'
        : powershellSkip,
  },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertEarlyRunUatFailureRetainsConsoleOutput(powershellExecutable)
  },
)
