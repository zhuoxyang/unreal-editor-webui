import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
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
const WINDOWS_NPM_PROBE_SCRIPT =
  '@echo off\r\nsetlocal EnableDelayedExpansion\r\n>> "%NPM_PROBE%" echo npm %*\r\nif /I "%*"=="ci" if defined NPM_PROBE_CWD_SHADOW_TEMPLATE (\r\n  copy /Y "%NPM_PROBE_CWD_SHADOW_TEMPLATE%" "npm.cmd" >nul\r\n  if errorlevel 1 exit /b 90\r\n)\r\nif /I "%*"=="--version" (\r\n  echo(!NPM_PROBE_VERSION!\r\n  exit /b 0\r\n)\r\nif /I "%NPM_PROBE_MODE%"=="succeed" (\r\n  if /I "%*"=="run build" (\r\n    set /p BUILD_INPUT=<"build-input.txt"\r\n    if not exist "..\\Web\\dist" mkdir "..\\Web\\dist"\r\n    > "..\\Web\\dist\\index.html" echo generated !BUILD_INPUT!\r\n  )\r\n  exit /b 0\r\n)\r\nexit /b 91\r\n'

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

function runGit(root, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 0, output)
  return result.stdout.trim()
}

function createFixture(lockfile, shellKind) {
  const root = mkdtempSync(join(tmpdir(), 'unreal webui registry guard-'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'unreal webui package temp-'))
  const scriptsDir = join(root, 'scripts')
  const frontendDir = join(root, 'frontend')
  const probeBin = join(tempRoot, 'probe-bin')
  mkdirSync(scriptsDir)
  mkdirSync(frontendDir)
  mkdirSync(probeBin)

  for (const scriptName of [
    'package-plugin.ps1',
    'package-plugin.sh',
    'stage-plugin-from-commit.mjs',
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
  copyFileSync(join(REPOSITORY_ROOT, 'frontend', 'package.json'), join(frontendDir, 'package.json'))
  copyFileSync(join(REPOSITORY_ROOT, 'frontend', '.npmrc'), join(frontendDir, '.npmrc'))
  writeFileSync(join(frontendDir, 'build-input.txt'), 'committed frontend', 'utf8')
  for (const rootFile of ['.npmrc', '.nvmrc', 'package.json']) {
    copyFileSync(join(REPOSITORY_ROOT, rootFile), join(root, rootFile))
  }
  mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true })
  copyFileSync(
    join(REPOSITORY_ROOT, 'tests', 'fixtures', 'command-schema-v1.json'),
    join(root, 'tests', 'fixtures', 'command-schema-v1.json'),
  )
  mkdirSync(join(root, 'Source'), { recursive: true })
  mkdirSync(join(root, 'Web'), { recursive: true })
  writeFileSync(join(root, 'Source', 'fixture.txt'), 'committed source\n', 'utf8')
  writeFileSync(join(root, 'Web', 'index.html'), '<!doctype html>tracked fallback\n', 'utf8')
  writeFileSync(join(root, 'LICENSE'), 'fixture license\n', 'utf8')
  writeFileSync(join(root, 'UnrealEditorWebUI.uplugin'), '{}\n', 'utf8')

  runGit(root, ['init', '--quiet'])
  runGit(root, ['config', 'user.name', 'Exact Commit Fixture'])
  runGit(root, ['config', 'user.email', 'fixture@example.invalid'])
  runGit(root, [
    'add',
    '--',
    '.npmrc',
    '.nvmrc',
    'package.json',
    'LICENSE',
    'UnrealEditorWebUI.uplugin',
    'frontend',
    'scripts',
    'tests/fixtures/command-schema-v1.json',
    'Source',
    'Web/index.html',
  ])
  runGit(root, ['commit', '--quiet', '-m', 'fixture'])
  const sourceCommit = runGit(root, ['rev-parse', 'HEAD'])

  mkdirSync(join(root, 'Web', 'dist'), { recursive: true })
  writeFileSync(join(root, 'Web', 'dist', 'index.html'), 'live worktree sentinel\n', 'utf8')

  const npmProbe = join(root, 'npm-probe.txt')
  const runUatProbe = join(root, 'runuat-probe.txt')
  const packageDir = join(root, 'package-output')
  let runUat
  if (shellKind === 'powershell' && process.platform === 'win32') {
    writeFileSync(
      join(probeBin, 'npm.cmd'),
      WINDOWS_NPM_PROBE_SCRIPT,
      'utf8',
    )
    runUat = join(probeBin, 'RunUAT.cmd')
    writeFileSync(
      runUat,
      '@echo off\r\nsetlocal EnableDelayedExpansion\r\n> "%RUNUAT_PROBE%" echo RunUAT %*\r\necho %RUNUAT_STDOUT_SENTINEL%\r\n>&2 echo %RUNUAT_STDERR_SENTINEL%\r\nif /I "%RUNUAT_PROBE_MODE%"=="fail-before-log" exit /b 94\r\nif defined uebp_LogFolder (\r\n  if not "%uebp_LogFolder%"=="%uebp_FinalLogFolder%" exit /b 93\r\n  if not exist "%uebp_LogFolder%" mkdir "%uebp_LogFolder%"\r\n  > "%uebp_LogFolder%\\Log.txt" echo uebp_LogFolder=%uebp_LogFolder%\r\n  >> "%uebp_LogFolder%\\Log.txt" echo uebp_FinalLogFolder=%uebp_FinalLogFolder%\r\n)\r\nif /I "%RUNUAT_PROBE_MODE%"=="succeed" (\r\n  set "PLUGIN_PATH="\r\n  set "PACKAGE_PATH="\r\n  for %%A in (%*) do (\r\n    set "ARG=%%~A"\r\n    if /I "!ARG:~0,8!"=="-Plugin=" set "PLUGIN_PATH=!ARG:~8!"\r\n    if /I "!ARG:~0,9!"=="-Package=" set "PACKAGE_PATH=!ARG:~9!"\r\n  )\r\n  if not defined PLUGIN_PATH exit /b 95\r\n  if not defined PACKAGE_PATH exit /b 95\r\n  for %%A in ("!PLUGIN_PATH!") do set "PLUGIN_DIR=%%~dpA"\r\n  if /I "%RUNUAT_CREATE_STALE_PACKAGE%"=="1" (\r\n    if not exist "%RUNUAT_PACKAGE_DIR%" mkdir "%RUNUAT_PACKAGE_DIR%"\r\n    > "%RUNUAT_PACKAGE_DIR%\\stale-race.sentinel" echo stale\r\n  )\r\n  if not exist "!PACKAGE_PATH!" mkdir "!PACKAGE_PATH!"\r\n  xcopy /E /I /Y "!PLUGIN_DIR!*" "!PACKAGE_PATH!\\" >nul\r\n  if errorlevel 2 exit /b 96\r\n  exit /b 0\r\n)\r\nexit /b 92\r\n',
      'utf8',
    )
  } else {
    if (process.platform === 'win32') {
      writeFileSync(
        join(probeBin, 'npm.cmd'),
        WINDOWS_NPM_PROBE_SCRIPT,
        'utf8',
      )
    }
    writeExecutable(
      join(probeBin, 'npm'),
      '#!/usr/bin/env sh\nprintf "npm %s\\n" "$*" >> "$NPM_PROBE"\nif [ "$*" = "--version" ]; then\n  printf "%s\\n" "${NPM_PROBE_VERSION:-}"\n  exit 0\nfi\nif [ "${NPM_PROBE_MODE:-fail}" = "succeed" ]; then\n  if [ "$*" = "run build" ]; then\n    mkdir -p ../Web/dist\n    printf "generated %s\\n" "$(cat build-input.txt)" > ../Web/dist/index.html\n  fi\n  exit 0\nfi\nexit 91\n',
    )
    runUat = join(probeBin, 'RunUAT')
    writeExecutable(
      runUat,
      '#!/usr/bin/env sh\nprintf "RunUAT %s\\n" "$*" > "$RUNUAT_PROBE"\nprintf "%s\\n" "$RUNUAT_STDOUT_SENTINEL"\nprintf "%s\\n" "$RUNUAT_STDERR_SENTINEL" >&2\nif [ "${RUNUAT_PROBE_MODE:-fail}" = "fail-before-log" ]; then\n  exit 94\nfi\nif [ -n "${uebp_LogFolder:-}" ]; then\n  if [ "$uebp_LogFolder" != "${uebp_FinalLogFolder:-}" ]; then\n    exit 93\n  fi\n  mkdir -p "$uebp_LogFolder"\n  printf "uebp_LogFolder=%s\\nuebp_FinalLogFolder=%s\\n" "$uebp_LogFolder" "$uebp_FinalLogFolder" > "$uebp_LogFolder/Log.txt"\nfi\nif [ "${RUNUAT_PROBE_MODE:-fail}" = "succeed" ]; then\n  plugin_path=""\n  package_path=""\n  for argument in "$@"; do\n    case "$argument" in\n      -Plugin=*) plugin_path="${argument#-Plugin=}" ;;\n      -Package=*) package_path="${argument#-Package=}" ;;\n    esac\n  done\n  [ -n "$plugin_path" ] || exit 95\n  [ -n "$package_path" ] || exit 95\n  if [ "${RUNUAT_CREATE_STALE_PACKAGE:-0}" = "1" ]; then\n    mkdir -p "$RUNUAT_PACKAGE_DIR"\n    printf "stale\\n" > "$RUNUAT_PACKAGE_DIR/stale-race.sentinel"\n  fi\n  mkdir -p "$package_path"\n  cp -R "$(dirname "$plugin_path")/." "$package_path/"\n  exit 0\nfi\nexit 92\n',
    )
  }

  const env = { ...process.env }
  const originalPath = env.PATH ?? env.Path ?? ''
  delete env.Path
  const inheritedPathEntries = originalPath.split(delimiter).filter((entry) => entry.length > 0)
  env.PATH = [probeBin, dirname(process.execPath), ...inheritedPathEntries].join(delimiter)
  env.NPM_PROBE = npmProbe
  env.NPM_PROBE_MODE = 'fail'
  env.NPM_PROBE_VERSION = '11.16.0'
  env.RUNUAT_PACKAGE_DIR = packageDir
  env.RUNUAT_PROBE = runUatProbe
  env.RUNUAT_PROBE_MODE = 'fail'
  env.RUNUAT_STDERR_SENTINEL = 'current-run-uat-stderr-sentinel'
  env.RUNUAT_STDOUT_SENTINEL = 'current-run-uat-stdout-sentinel'
  env.TEMP = tempRoot
  env.TMP = tempRoot
  env.TMPDIR = tempRoot

  return {
    env,
    frontendDir,
    initialDirectories: topLevelDirectories(tempRoot),
    npmProbe,
    packageDir,
    probeBin,
    root,
    runUat,
    runUatProbe,
    scriptsDir,
    sourceCommit,
    tempRoot,
  }
}

function cleanupFixture(fixture) {
  rmSync(fixture.root, { force: true, recursive: true })
  rmSync(fixture.tempRoot, { force: true, recursive: true })
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

function runPackageScript(shellKind, fixture, executable, sourceCommit = fixture.sourceCommit) {
  if (shellKind === 'bash') {
    return spawnSync(
      executable,
      [
        join(fixture.scriptsDir, 'package-plugin.sh'),
        fixture.runUat,
        fixture.packageDir,
        sourceCommit,
      ],
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
      '-SourceCommit',
      sourceCommit,
    ],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: fixture.env,
      windowsHide: true,
    },
  )
}

function relativeRegularFiles(root) {
  const files = []
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const stat = statSync(absolutePath)
      if (stat.isDirectory()) visit(absolutePath, relativePath)
      else if (stat.isFile()) files.push(relativePath)
      else assert.fail(`unexpected package entry: ${relativePath}`)
    }
  }
  visit(root, '')
  return files.sort()
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function assertDirtyWorktreeCannotEnterPackage(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_PROBE_MODE = 'succeed'

  writeFileSync(join(fixture.root, 'LICENSE'), 'dirty live license\n', 'utf8')
  writeFileSync(join(fixture.root, 'UnrealEditorWebUI.uplugin'), '{"dirty":true}\n', 'utf8')
  writeFileSync(join(fixture.root, 'Source', 'fixture.txt'), 'dirty live source\n', 'utf8')
  writeFileSync(join(fixture.root, 'frontend', 'build-input.txt'), 'dirty frontend', 'utf8')
  writeFileSync(join(fixture.root, 'Web', 'dist', 'index.html'), 'dirty live dist\n', 'utf8')

  const pluginDirectories = [
    'Config',
    'Content',
    'Platforms',
    'Python',
    'Resources',
    'Shaders',
    'Source',
    'Web',
  ]
  const sentinels = []
  for (const directory of pluginDirectories) {
    const sentinel = join(fixture.root, directory, `untracked-${directory}.sentinel`)
    mkdirSync(dirname(sentinel), { recursive: true })
    writeFileSync(sentinel, 'must not be packaged\n', 'utf8')
    sentinels.push(`${directory}/untracked-${directory}.sentinel`)
  }
  writeFileSync(
    join(fixture.root, 'frontend', 'untracked-build-input.sentinel'),
    'must not affect build\n',
    'utf8',
  )

  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 0, output)
    assert.equal(readFileSync(join(fixture.packageDir, 'LICENSE'), 'utf8'), 'fixture license\n')
    assert.equal(
      readFileSync(join(fixture.packageDir, 'UnrealEditorWebUI.uplugin'), 'utf8'),
      '{}\n',
    )
    assert.equal(
      readFileSync(join(fixture.packageDir, 'Source', 'fixture.txt'), 'utf8'),
      'committed source\n',
    )
    assert.equal(
      readFileSync(join(fixture.packageDir, 'Web', 'dist', 'index.html'), 'utf8').trim(),
      'generated committed frontend',
    )
    for (const sentinel of sentinels) {
      assert.equal(existsSync(join(fixture.packageDir, ...sentinel.split('/'))), false, sentinel)
    }

    const manifestPath = join(fixture.packageDir, 'SourceManifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.sourceCommit, fixture.sourceCommit)
    assert.deepEqual(manifest.buildToolchain, {
      nodeVersion: process.versions.node,
      nodeArchitecture: process.arch,
      npmVersion: fixture.env.NPM_PROBE_VERSION,
    })
    assert.deepEqual(
      manifest.files.map(({ path }) => path),
      relativeRegularFiles(fixture.packageDir).filter((path) => path !== 'SourceManifest.json'),
    )
    assert.deepEqual(
      manifest.files.map(({ path }) => path),
      [...manifest.files.map(({ path }) => path)].sort(),
      'manifest paths must be deterministic',
    )

    const generated = manifest.files.filter(({ source }) => source === 'generated')
    assert.ok(generated.some(({ path }) => path === 'Web/dist/index.html'))
    assert.ok(generated.every(({ path }) => path.startsWith('Web/dist/')))
    assert.ok(
      manifest.files
        .filter(({ source }) => source === 'tracked')
        .every(({ path }) => !path.startsWith('Web/dist/')),
    )
    for (const file of manifest.files) {
      if (file.source === 'tracked') {
        assert.ok(
          ['LICENSE', 'UnrealEditorWebUI.uplugin'].includes(file.path) ||
            pluginDirectories.some(
              (directory) => file.path.startsWith(`${directory}/`),
            ),
          `tracked manifest path is outside the plugin allowlist: ${file.path}`,
        )
        assert.ok(['100644', '100755'].includes(file.mode), `${file.path}: ${file.mode}`)
        assert.equal(
          file.gitObject,
          runGit(fixture.root, ['rev-parse', `${fixture.sourceCommit}:${file.path}`]),
          file.path,
        )
      } else {
        assert.equal(file.source, 'generated', file.path)
        assert.ok(file.path.startsWith('Web/dist/'), file.path)
      }
      const packagedPath = join(fixture.packageDir, ...file.path.split('/'))
      assert.equal(file.sha256, sha256File(packagedPath), file.path)
      assert.equal(file.size, statSync(packagedPath).size, file.path)
    }

    assert.equal(readFileSync(join(fixture.root, 'LICENSE'), 'utf8'), 'dirty live license\n')
    assert.equal(
      readFileSync(join(fixture.root, 'Web', 'dist', 'index.html'), 'utf8'),
      'dirty live dist\n',
    )
  } finally {
    cleanupFixture(fixture)
  }
}

function assertInvalidSourceCommitsStopBeforeCommands(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  const licenseBlob = runGit(fixture.root, ['rev-parse', `${fixture.sourceCommit}:LICENSE`])
  try {
    for (const sourceCommit of ['1'.repeat(39), 'f'.repeat(40), licenseBlob]) {
      const result = runPackageScript(shellKind, fixture, executable, sourceCommit)
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      assert.equal(result.error, undefined, output)
      assert.equal(result.signal, null, output)
      assert.equal(result.status, 1, output)
      assert.match(output, /full 40-character|exactly 40 hexadecimal|git rev-parse failed/u)
      assert.equal(existsSync(fixture.npmProbe), false, 'invalid commit must stop before npm')
      assert.equal(existsSync(fixture.runUatProbe), false, 'invalid commit must stop before RunUAT')
      assert.equal(existsSync(fixture.packageDir), false, 'invalid commit must not create a package')
      assert.deepEqual(topLevelDirectories(fixture.tempRoot), fixture.initialDirectories)
    }
  } finally {
    cleanupFixture(fixture)
  }
}

function assertUnsafeCommittedEntriesStopBeforeCommands(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  try {
    const linkObject = runGit(fixture.root, [
      'rev-parse',
      `${fixture.sourceCommit}:Source/fixture.txt`,
    ])
    runGit(fixture.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `120000,${linkObject},Source/committed-link`,
    ])
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add symlink entry'])
    const symlinkCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])
    const symlinkResult = runPackageScript(shellKind, fixture, executable, symlinkCommit)
    const symlinkOutput = `${symlinkResult.stdout ?? ''}\n${symlinkResult.stderr ?? ''}`
    assert.equal(symlinkResult.error, undefined, symlinkOutput)
    assert.equal(symlinkResult.status, 1, symlinkOutput)
    assert.match(symlinkOutput, /Symlinks and gitlinks are not supported/u)

    runGit(fixture.root, ['rm', '--cached', '--quiet', '--', 'Source/committed-link'])
    runGit(fixture.root, ['add', '-f', '--', 'Web/dist/index.html'])
    runGit(fixture.root, ['commit', '--quiet', '-m', 'replace link with tracked dist'])
    const trackedDistCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])
    const trackedDistResult = runPackageScript(
      shellKind,
      fixture,
      executable,
      trackedDistCommit,
    )
    const trackedDistOutput = `${trackedDistResult.stdout ?? ''}\n${trackedDistResult.stderr ?? ''}`
    assert.equal(trackedDistResult.error, undefined, trackedDistOutput)
    assert.equal(trackedDistResult.status, 1, trackedDistOutput)
    assert.match(trackedDistOutput, /Web\/dist must be generated and untracked/u)

    runGit(fixture.root, ['rm', '--cached', '--quiet', '--', 'Web/dist/index.html'])
    runGit(fixture.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${linkObject},Web/Dist/collision.txt`,
    ])
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add portable dist collision'])
    const portableDistCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])
    const portableDistResult = runPackageScript(
      shellKind,
      fixture,
      executable,
      portableDistCommit,
    )
    const portableDistOutput = `${portableDistResult.stdout ?? ''}\n${portableDistResult.stderr ?? ''}`
    assert.equal(portableDistResult.error, undefined, portableDistOutput)
    assert.equal(portableDistResult.status, 1, portableDistOutput)
    assert.match(portableDistOutput, /Web\/dist must be generated and untracked/u)

    runGit(fixture.root, ['rm', '--cached', '--quiet', '--', 'Web/Dist/collision.txt'])
    runGit(fixture.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${linkObject},Web/Index.html/collision.txt`,
    ])
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add case-colliding directory'])
    const collisionCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])
    const collisionResult = runPackageScript(shellKind, fixture, executable, collisionCommit)
    const collisionOutput = `${collisionResult.stdout ?? ''}\n${collisionResult.stderr ?? ''}`
    assert.equal(collisionResult.error, undefined, collisionOutput)
    assert.equal(collisionResult.status, 1, collisionOutput)
    assert.match(collisionOutput, /Paths collide on a case-insensitive filesystem/u)

    runGit(fixture.root, ['rm', '--cached', '--quiet', '--', 'Web/Index.html/collision.txt'])
    runGit(fixture.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${linkObject},Content`,
    ])
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add plugin directory blob'])
    const directoryBlobCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])
    const directoryBlobResult = runPackageScript(
      shellKind,
      fixture,
      executable,
      directoryBlobCommit,
    )
    const directoryBlobOutput = `${directoryBlobResult.stdout ?? ''}\n${directoryBlobResult.stderr ?? ''}`
    assert.equal(directoryBlobResult.error, undefined, directoryBlobOutput)
    assert.equal(directoryBlobResult.status, 1, directoryBlobOutput)
    assert.match(directoryBlobOutput, /Plugin directory path must be a tree/u)

    assert.equal(existsSync(fixture.npmProbe), false, 'unsafe trees must stop before npm')
    assert.equal(existsSync(fixture.runUatProbe), false, 'unsafe trees must stop before RunUAT')
    assert.equal(existsSync(fixture.packageDir), false, 'unsafe trees must not create a package')
    assert.deepEqual(topLevelDirectories(fixture.tempRoot), fixture.initialDirectories)
  } finally {
    cleanupFixture(fixture)
  }
}

function assertAtomicPackagePublicationRejectsRace(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_CREATE_STALE_PACKAGE = '1'
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 1, output)
    assert.match(output, /created before exact package publication/u)
    assert.deepEqual(readdirSync(fixture.packageDir), ['stale-race.sentinel'])
    assert.equal(existsSync(join(fixture.packageDir, 'SourceManifest.json')), false)
    assert.equal(existsSync(fixture.runUatProbe), true)
    assert.equal(
      readdirSync(fixture.root).some((name) => name.startsWith('.unreal-editor-webui-package')),
      false,
      'private BuildPlugin output must be cleaned after a publication race',
    )
    assert.deepEqual(topLevelDirectories(fixture.tempRoot), fixture.initialDirectories)
  } finally {
    cleanupFixture(fixture)
  }
}

function assertDanglingOutputSymlinkStopsBeforeCommands(executable, testContext) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'bash')
  try {
    try {
      symlinkSync('missing-package-target', fixture.packageDir, 'dir')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        testContext.skip('creating symbolic links is not permitted on this host')
        return
      }
      throw error
    }

    const result = runPackageScript('bash', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 1, output)
    assert.match(output, /must not already exist/u)
    assert.equal(existsSync(fixture.npmProbe), false, 'stale output must stop before npm')
    assert.equal(existsSync(fixture.runUatProbe), false, 'stale output must stop before RunUAT')
  } finally {
    cleanupFixture(fixture)
  }
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
    cleanupFixture(fixture)
  }
}

function assertOfficialLockReachesNpmProbe(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 1, output)
    assert.match(output, /Validated 1 npm lockfile URL/u)
    assert.equal(existsSync(fixture.npmProbe), true, 'the official lock must reach npm')
    assert.deepEqual(
      readFileSync(fixture.npmProbe, 'utf8').trim().split(/\r?\n/u),
      ['npm --version', 'npm ci'],
    )
    assert.equal(existsSync(fixture.runUatProbe), false, 'the failing npm probe must stop before RunUAT')
    unlinkSync(fixture.npmProbe)
  } finally {
    cleanupFixture(fixture)
  }
}

function assertMalformedNpmVersionStopsBeforeInstall(shellKind, executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, shellKind)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.NPM_PROBE_VERSION = '11.16.0 unexpected-output'
  try {
    const result = runPackageScript(shellKind, fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 1, output)
    assert.match(output, /npm version probe must return a stable semantic version/iu)
    assert.deepEqual(
      readFileSync(fixture.npmProbe, 'utf8').trim().split(/\r?\n/u),
      ['npm --version'],
    )
    assert.equal(existsSync(fixture.runUatProbe), false, 'invalid npm evidence must stop before RunUAT')
    assert.equal(existsSync(fixture.packageDir), false, 'invalid npm evidence must not publish a package')
  } finally {
    cleanupFixture(fixture)
  }
}

function assertTrackedFrontendNpmCmdCannotHijack(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const shadowProbe = join(fixture.root, 'tracked-npm-cmd-shadow.txt')
  fixture.env.NPM_CWD_SHADOW_PROBE = shadowProbe
  fixture.env.NPM_PROBE_MODE = 'succeed'
  writeFileSync(
    join(fixture.frontendDir, 'npm.cmd'),
    '@echo off\r\n> "%NPM_CWD_SHADOW_PROBE%" echo tracked frontend npm.cmd ran\r\necho 99.99.99\r\nexit /b 0\r\n',
    'utf8',
  )
  runGit(fixture.root, ['add', '--', 'frontend/npm.cmd'])
  runGit(fixture.root, ['commit', '--quiet', '-m', 'add tracked npm shadow'])
  fixture.sourceCommit = runGit(fixture.root, ['rev-parse', 'HEAD'])

  try {
    const result = runPackageScript('powershell', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 92, output)
    assert.equal(existsSync(shadowProbe), false, 'tracked frontend/npm.cmd must never run')
    assert.deepEqual(
      readFileSync(fixture.npmProbe, 'utf8').trim().split(/\r?\n/u),
      ['npm --version', 'npm ci', 'npm run build'],
    )
  } finally {
    cleanupFixture(fixture)
  }
}

function assertLifecycleCreatedNpmCmdCannotHijack(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const shadowProbe = join(fixture.root, 'lifecycle-npm-cmd-shadow.txt')
  const shadowTemplate = join(fixture.probeBin, 'lifecycle-npm-shadow.cmd')
  fixture.env.NPM_CWD_SHADOW_PROBE = shadowProbe
  fixture.env.NPM_PROBE_CWD_SHADOW_TEMPLATE = shadowTemplate
  fixture.env.NPM_PROBE_MODE = 'succeed'
  writeFileSync(
    shadowTemplate,
    '@echo off\r\n> "%NPM_CWD_SHADOW_PROBE%" echo lifecycle npm.cmd ran\r\nexit /b 77\r\n',
    'utf8',
  )

  try {
    const result = runPackageScript('powershell', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 92, output)
    assert.equal(existsSync(shadowProbe), false, 'npm ci-created npm.cmd must never run')
    assert.deepEqual(
      readFileSync(fixture.npmProbe, 'utf8').trim().split(/\r?\n/u),
      ['npm --version', 'npm ci', 'npm run build'],
    )
  } finally {
    cleanupFixture(fixture)
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
      ['npm --version', 'npm ci', 'npm run build'],
    )
    assert.match(readFileSync(fixture.runUatProbe, 'utf8'), /^RunUAT BuildPlugin\b/u)
    assert.equal(existsSync(fixture.packageDir), false, 'RunUAT failure must not publish a package')
    assert.deepEqual(
      topLevelDirectories(fixture.tempRoot),
      fixture.initialDirectories,
      'the staging directory must be removed after RunUAT fails',
    )
    assert.equal(
      readdirSync(fixture.root).some((name) => name.startsWith('.unreal-editor-webui-package')),
      false,
      'private BuildPlugin output must be removed after RunUAT fails',
    )
  } finally {
    cleanupFixture(fixture)
  }
}

function assertPowerShellBuildPackageUsesShortTempRoot(executable) {
  const fixture = createFixture(OFFICIAL_LOCKFILE, 'powershell')
  const delegatedRunUat = fixture.runUat
  const maxPrivatePackageLength = 150
  let deepPackageParent = fixture.root
  while (deepPackageParent.length < maxPrivatePackageLength + 20) {
    deepPackageParent = join(deepPackageParent, 'deep-package-parent')
  }
  mkdirSync(deepPackageParent, { recursive: true })
  fixture.packageDir = join(deepPackageParent, 'package-output')
  fixture.env.RUNUAT_PACKAGE_DIR = fixture.packageDir

  const hypotheticalSibling = join(
    deepPackageParent,
    `.unreal-editor-webui-package-${'0'.repeat(32)}`,
  )
  assert.ok(
    hypotheticalSibling.length > maxPrivatePackageLength,
    'the fixture must reproduce the former long private-output layout',
  )

  const lengthGuardRunUat = join(fixture.root, 'RunUAT-length-guard.ps1')
  writeFileSync(
    lengthGuardRunUat,
    `$PackageArgument = @($args | Where-Object { $_ -like '-Package=*' })
if ($PackageArgument.Count -ne 1) {
    throw 'Expected exactly one -Package argument.'
}
$PrivatePackageDir = $PackageArgument[0].Substring('-Package='.Length)
if ($PrivatePackageDir.Length -gt [int]$env:RUNUAT_MAX_PACKAGE_PATH) {
    $global:LASTEXITCODE = 97
    return
}
& $env:RUNUAT_DELEGATE @args
`,
    'utf8',
  )
  fixture.runUat = lengthGuardRunUat
  fixture.env.RUNUAT_DELEGATE = delegatedRunUat
  fixture.env.RUNUAT_MAX_PACKAGE_PATH = String(maxPrivatePackageLength)
  fixture.env.NPM_PROBE_MODE = 'succeed'
  fixture.env.RUNUAT_PROBE_MODE = 'succeed'
  try {
    const result = runPackageScript('powershell', fixture, executable)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    assert.equal(result.error, undefined, output)
    assert.equal(result.signal, null, output)
    assert.equal(result.status, 0, output)

    const invocation = readFileSync(fixture.runUatProbe, 'utf8').trim()
    const packageArgument = invocation.match(/-Package=(.+?)(?="?\s+"?-Rocket(?:"|\s|$))/u)
    assert.notEqual(packageArgument, null, invocation)
    const privatePackageDir = packageArgument[1].replace(/^"|"$/gu, '')
    assert.ok(privatePackageDir.length <= maxPrivatePackageLength)
    const privateParentIdentity = statSync(dirname(privatePackageDir), { bigint: true })
    const tempRootIdentity = statSync(fixture.tempRoot, { bigint: true })
    assert.equal(privateParentIdentity.dev, tempRootIdentity.dev)
    assert.equal(privateParentIdentity.ino, tempRootIdentity.ino)
    assert.match(basename(privatePackageDir), /^uewp-[0-9a-f]{32}$/u)
    assert.equal(existsSync(privatePackageDir), false, 'private output must move to PackageDir')
    assert.equal(existsSync(fixture.packageDir), true, 'the package must be published')
    assert.deepEqual(topLevelDirectories(fixture.tempRoot), fixture.initialDirectories)
  } finally {
    cleanupFixture(fixture)
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
    [string]$SourceCommit,
    [string]$ConsoleLog
)

$ErrorActionPreference = "Stop"
$PreviousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $PowerShellExecutable -NoProfile -ExecutionPolicy Bypass -File $PackageScript -RunUAT $RunUAT -PackageDir $PackageDir -SourceCommit $SourceCommit 2>&1 | Tee-Object -FilePath $ConsoleLog
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
      '-SourceCommit',
      fixture.sourceCommit,
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
    cleanupFixture(fixture)
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
    cleanupFixture(fixture)
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
    cleanupFixture(fixture)
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

test('Bash packaging rejects malformed npm version evidence before install', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertMalformedNpmVersionStopsBeforeInstall('bash', bashExecutable)
})

test('Bash packaging cleans staging when RunUAT fails', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertRunUatFailureCleansStaging('bash', bashExecutable)
})

test('Bash packaging stages only the selected commit and its generated frontend', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertDirtyWorktreeCannotEnterPackage('bash', bashExecutable)
})

test('Bash packaging rejects incomplete, missing, and non-commit object IDs', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertInvalidSourceCommitsStopBeforeCommands('bash', bashExecutable)
})

test('Bash packaging rejects committed symlinks and tracked Web/dist', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertUnsafeCommittedEntriesStopBeforeCommands('bash', bashExecutable)
})

test('Bash packaging atomically rejects a raced final output directory', { skip: bashSkip }, () => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertAtomicPackagePublicationRejectsRace('bash', bashExecutable)
})

test('Bash packaging rejects a dangling output symlink before running commands', { skip: bashSkip }, (testContext) => {
  assert.ok(bashAvailable, 'bash is required in CI')
  assertDanglingOutputSymlinkStopsBeforeCommands(bashExecutable, testContext)
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
  'PowerShell packaging rejects malformed npm version evidence before install',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertMalformedNpmVersionStopsBeforeInstall('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging ignores a tracked frontend npm.cmd shadow',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows cmd lookup behavior is required'
        : powershellSkip,
  },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertTrackedFrontendNpmCmdCannotHijack(powershellExecutable)
  },
)

test(
  'PowerShell packaging keeps the frozen npm launcher after npm ci creates npm.cmd',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows cmd lookup behavior is required'
        : powershellSkip,
  },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertLifecycleCreatedNpmCmdCannotHijack(powershellExecutable)
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
  'PowerShell packaging keeps private BuildPlugin output under the short temp root',
  {
    skip:
      process.platform !== 'win32'
        ? 'Windows volume identity and PowerShell 5.1 are required'
        : powershellSkip,
  },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertPowerShellBuildPackageUsesShortTempRoot(powershellExecutable)
  },
)

test(
  'PowerShell packaging stages only the selected commit and its generated frontend',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertDirtyWorktreeCannotEnterPackage('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging rejects incomplete, missing, and non-commit object IDs',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertInvalidSourceCommitsStopBeforeCommands('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging rejects committed symlinks and tracked Web/dist',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertUnsafeCommittedEntriesStopBeforeCommands('powershell', powershellExecutable)
  },
)

test(
  'PowerShell packaging atomically rejects a raced final output directory',
  { skip: powershellSkip },
  () => {
    assert.ok(powershellAvailable, 'PowerShell is required in CI')
    assertAtomicPackagePublicationRejectsRace('powershell', powershellExecutable)
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
