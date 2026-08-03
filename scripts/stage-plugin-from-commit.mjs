import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLUGIN_DIRECTORIES = Object.freeze([
  'Config',
  'Content',
  'Platforms',
  'Python',
  'Resources',
  'Shaders',
  'Source',
  'Web',
])

export const PLUGIN_ROOT_FILES = Object.freeze([
  'LICENSE',
  'UnrealEditorWebUI.uplugin',
])

export const GENERATED_WEB_DIRECTORY = 'Web/dist'

const BUILD_SCRIPT_FILES = Object.freeze([
  'scripts/validate-node-version.mjs',
  'scripts/validate-npm-lock-registry.mjs',
])
export const EXACT_COMMIT_INPUT_PATHS = Object.freeze([
  ...BUILD_SCRIPT_FILES,
  'frontend',
  'tests/fixtures/command-schema-v1.json',
  ...PLUGIN_ROOT_FILES,
  ...PLUGIN_DIRECTORIES,
])

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/u
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}$/u
const REGULAR_GIT_MODES = new Set(['100644', '100755'])
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu
const WINDOWS_UNSAFE_CHARACTER_PATTERN = /[<>:"\\|?*]/u
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMissingPathError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT'
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

function comparablePath(path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameFilesystemEntry(left, right) {
  const leftNativePath = comparablePath(realpathSync.native(left))
  const rightNativePath = comparablePath(realpathSync.native(right))
  if (leftNativePath === rightNativePath) return true

  const leftStat = statSync(left, { bigint: true })
  const rightStat = statSync(right, { bigint: true })
  if (leftStat.ino === 0n || rightStat.ino === 0n) return false
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function isExistingPathInside(parent, candidate) {
  const parentPath = realpathSync.native(parent)
  let currentPath = realpathSync.native(candidate)
  while (true) {
    if (isSameFilesystemEntry(parentPath, currentPath)) return true
    const nextPath = dirname(currentPath)
    if (nextPath === currentPath) return false
    currentPath = nextPath
  }
}

function isSameOrDescendant(parent, candidate) {
  const parentPath = comparablePath(parent)
  const candidatePath = comparablePath(candidate)
  const childPath = relative(parentPath, candidatePath)
  return childPath === '' || (!childPath.startsWith(`..${sep}`) && childPath !== '..' && !isAbsolute(childPath))
}

function canonicalFreshOutputPath(input, label, repositoryRoot) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error(`${label} must be a non-empty filesystem path.`)
  }

  const requestedPath = resolve(input)
  if (pathExists(requestedPath)) {
    throw new Error(`${label} must be fresh and must not already exist: ${requestedPath}`)
  }

  const requestedParent = dirname(requestedPath)
  let parentStat
  try {
    parentStat = lstatSync(requestedParent)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`${label} parent directory does not exist: ${requestedParent}`)
    }
    throw error
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`${label} parent is not a directory: ${requestedParent}`)
  }

  const canonicalParent = realpathSync(requestedParent)
  const canonicalPath = join(canonicalParent, basename(requestedPath))
  if (isExistingPathInside(repositoryRoot, canonicalParent)) {
    throw new Error(`${label} must be outside the repository: ${canonicalPath}`)
  }
  return canonicalPath
}

function assertIndependentOutputs(pluginStage, manifestPath) {
  const sameParent = isSameFilesystemEntry(dirname(pluginStage), dirname(manifestPath))
  if (
    (sameParent &&
      comparablePath(basename(pluginStage)) === comparablePath(basename(manifestPath))) ||
    isSameOrDescendant(pluginStage, manifestPath)
  ) {
    throw new Error('Manifest path must be separate from and outside the plugin stage.')
  }
}

function gitEnvironment() {
  const environment = { ...process.env }
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) {
    delete environment[name]
  }
  environment.GIT_LITERAL_PATHSPECS = '1'
  environment.GIT_NO_REPLACE_OBJECTS = '1'
  return environment
}

function runGit(args, options = {}) {
  const result = spawnSync(
    'git',
    ['--no-replace-objects', '-C', REPOSITORY_ROOT, ...args],
    {
      encoding: null,
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
      ...options,
    },
  )
  if (result.error) {
    throw new Error(`Unable to run git ${args[0]}: ${result.error.message}`)
  }
  if (result.signal) {
    throw new Error(`git ${args[0]} was terminated by signal ${result.signal}.`)
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim()
    throw new Error(
      `git ${args[0]} failed with exit code ${result.status}${stderr ? `: ${stderr}` : '.'}`,
    )
  }
  return result.stdout ?? Buffer.alloc(0)
}

function runCommand(
  command,
  args,
  cwd,
  label,
  { captureOutput = false, windowsVerbatimArguments = false } = {},
) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: captureOutput ? 'utf8' : undefined,
      env: process.env,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsVerbatimArguments,
      windowsHide: true,
    })
  } catch (error) {
    if (error && typeof error === 'object' && error.signal) {
      throw new Error(`${label} was terminated by signal ${error.signal}.`)
    }
    if (error && typeof error === 'object' && Number.isInteger(error.status)) {
      throw new Error(`${label} failed with exit code ${error.status}.`)
    }
    throw new Error(`${label} could not start: ${errorText(error)}`)
  }
}

function pathEntries() {
  const value = process.env.PATH ?? process.env.Path
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('PATH must be a non-empty list of absolute directories.')
  }

  return value.split(delimiter).map((rawEntry) => {
    const entry =
      rawEntry.length >= 2 && rawEntry.startsWith('"') && rawEntry.endsWith('"')
        ? rawEntry.slice(1, -1)
        : rawEntry
    if (entry.length === 0 || entry.includes('\0') || !isAbsolute(entry)) {
      throw new Error('PATH must contain only non-empty absolute directory entries.')
    }
    return entry
  })
}

function assertTrustedLauncherPath(candidate, canonicalCandidate, untrustedRoots) {
  if (
    untrustedRoots.some(
      (root) =>
        isSameOrDescendant(root, candidate) || isSameOrDescendant(root, canonicalCandidate),
    )
  ) {
    throw new Error('The npm launcher resolved inside repository-controlled build input.')
  }
}

function resolveNpmExecutable(untrustedRoots) {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm']
  for (const directory of pathEntries()) {
    for (const name of names) {
      const candidate = resolve(directory, name)
      let candidateStat
      try {
        candidateStat = statSync(candidate)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw new Error('Unable to inspect an npm launcher candidate from PATH.')
      }
      if (!candidateStat.isFile()) {
        throw new Error('An npm launcher candidate from PATH is not a regular file.')
      }

      let canonicalCandidate
      try {
        canonicalCandidate = realpathSync.native(candidate)
      } catch {
        throw new Error('Unable to canonicalize the npm launcher selected from PATH.')
      }
      if (!isAbsolute(canonicalCandidate)) {
        throw new Error('The npm launcher selected from PATH is not absolute.')
      }
      assertTrustedLauncherPath(candidate, canonicalCandidate, untrustedRoots)
      return canonicalCandidate
    }
  }
  throw new Error('Unable to resolve an npm launcher from PATH.')
}

function resolveWindowsCommandProcessor() {
  const systemRoot = process.env.SystemRoot
  if (
    typeof systemRoot !== 'string' ||
    systemRoot.length === 0 ||
    systemRoot.includes('\0') ||
    !isAbsolute(systemRoot)
  ) {
    throw new Error('SystemRoot must identify an absolute Windows directory.')
  }

  let canonicalSystemRoot
  let canonicalCommandProcessor
  try {
    canonicalSystemRoot = realpathSync.native(systemRoot)
    canonicalCommandProcessor = realpathSync.native(resolve(systemRoot, 'System32', 'cmd.exe'))
  } catch {
    throw new Error('Unable to resolve the Windows system command processor.')
  }
  if (
    !isSameOrDescendant(canonicalSystemRoot, canonicalCommandProcessor) ||
    !statSync(canonicalCommandProcessor).isFile()
  ) {
    throw new Error('The Windows system command processor is invalid.')
  }
  return canonicalCommandProcessor
}

function resolveNpmLauncher(untrustedRoots) {
  const executable = resolveNpmExecutable(untrustedRoots)
  if (process.platform !== 'win32') {
    return Object.freeze({ executable, kind: 'direct' })
  }
  if (/["\r\n%&|<>^!]/u.test(executable)) {
    throw new Error('The Windows npm launcher path cannot be quoted safely.')
  }
  return Object.freeze({
    commandProcessor: resolveWindowsCommandProcessor(),
    executable,
    kind: 'windows-command',
  })
}

function assertSupportedNpmArguments(args) {
  if (
    (args.length === 1 && (args[0] === '--version' || args[0] === 'ci')) ||
    (args.length === 2 && args[0] === 'run' && args[1] === 'build')
  ) {
    return
  }
  throw new Error(`Unsupported exact-commit npm command: ${JSON.stringify(args)}`)
}

function runNpm(launcher, args, cwd, label, options) {
  assertSupportedNpmArguments(args)
  if (launcher.kind === 'windows-command') {
    const command = `""${launcher.executable}" ${args.join(' ')}"`
    return runCommand(
      launcher.commandProcessor,
      ['/d', '/s', '/v:off', '/c', command],
      cwd,
      label,
      { ...options, windowsVerbatimArguments: true },
    )
  }
  return runCommand(launcher.executable, args, cwd, label, options)
}

function parseSingleLineStableSemver(output, label) {
  if (typeof output !== 'string') {
    throw new Error(`${label} did not return text.`)
  }
  const normalized = output.replace(/\r\n/gu, '\n')
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n')
  if (lines.length !== 1) {
    throw new Error(`${label} must return exactly one line.`)
  }
  const version = lines[0]
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error(`${label} must return a stable semantic version.`)
  }
  return version
}

function readExactNpmVersion(launcher, frontendDirectory) {
  const output = runNpm(
    launcher,
    ['--version'],
    frontendDirectory,
    'Exact-commit npm version probe',
    { captureOutput: true },
  )
  return parseSingleLineStableSemver(output, 'Exact-commit npm version probe')
}

async function validateExactBuildInputs(buildRoot) {
  const nodeValidatorPath = filesystemPath(buildRoot, 'scripts/validate-node-version.mjs')
  const nodeValidator = await import(pathToFileURL(nodeValidatorPath).href)
  if (
    typeof nodeValidator.isSupportedNodeVersion !== 'function' ||
    typeof nodeValidator.NODE_ENGINE_RANGE !== 'string'
  ) {
    throw new Error('Exact-commit Node.js validator exports are invalid.')
  }
  const nodeVersion = process.versions.node
  if (!nodeValidator.isSupportedNodeVersion(nodeVersion)) {
    throw new Error(
      `Unsupported Node.js ${nodeVersion}. Expected the exact commit's engine contract ${nodeValidator.NODE_ENGINE_RANGE}.`,
    )
  }
  console.log(
    `Node.js ${nodeVersion} satisfies the exact commit's engine requirement (${nodeValidator.NODE_ENGINE_RANGE}).`,
  )

  const registryValidatorPath = filesystemPath(
    buildRoot,
    'scripts/validate-npm-lock-registry.mjs',
  )
  const registryValidator = await import(pathToFileURL(registryValidatorPath).href)
  if (typeof registryValidator.validateNpmLockRegistry !== 'function') {
    throw new Error('Exact-commit npm registry validator exports are invalid.')
  }
  const lockfilePath = filesystemPath(buildRoot, 'frontend/package-lock.json')
  let lockfile
  try {
    lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read exact-commit npm lockfile: ${errorText(error)}`)
  }
  const validation = registryValidator.validateNpmLockRegistry(lockfile)
  if (
    !validation ||
    !Array.isArray(validation.errors) ||
    !Number.isSafeInteger(validation.resolvedCount)
  ) {
    throw new Error('Exact-commit npm registry validator returned an invalid result.')
  }
  if (validation.errors.length > 0) {
    throw new Error(
      `npm lockfile registry validation failed (${validation.errors.length} error(s)):\n` +
        validation.errors.map((error) => `- ${error}`).join('\n'),
    )
  }
  console.log(
    `Validated ${validation.resolvedCount} npm lockfile URLs against registry.npmjs.org.`,
  )
}

function assertSafePathComponent(component, repositoryPath) {
  if (
    component.length === 0 ||
    component === '.' ||
    component === '..' ||
    component.toLowerCase() === '.git' ||
    component.endsWith('.') ||
    component.endsWith(' ') ||
    CONTROL_CHARACTER_PATTERN.test(component) ||
    WINDOWS_UNSAFE_CHARACTER_PATTERN.test(component) ||
    WINDOWS_RESERVED_NAME_PATTERN.test(component)
  ) {
    throw new Error(`Git path is not portable or safe to materialize: ${repositoryPath}`)
  }
}

function assertSafeRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.length === 0 ||
    repositoryPath.startsWith('/') ||
    repositoryPath.startsWith('\\') ||
    /^[A-Za-z]:/u.test(repositoryPath)
  ) {
    throw new Error(`Git path is not repository-relative: ${repositoryPath}`)
  }

  const components = repositoryPath.split('/')
  for (const component of components) assertSafePathComponent(component, repositoryPath)
}

function portablePathKey(repositoryPath) {
  return repositoryPath.normalize('NFC').toLowerCase()
}

function assertNoPortablePathCollisions(paths) {
  const seen = new Map()
  for (const path of paths) {
    const components = path.split('/')
    for (let index = 0; index < components.length; index += 1) {
      const candidate = components.slice(0, index + 1).join('/')
      const kind = index === components.length - 1 ? 'file' : 'directory'
      const key = portablePathKey(candidate)
      const prior = seen.get(key)
      if (prior !== undefined && (prior.path !== candidate || prior.kind !== kind)) {
        throw new Error(
          `Paths collide on a case-insensitive filesystem: ${prior.path} (${prior.kind}) and ${candidate} (${kind})`,
        )
      }
      seen.set(key, { kind, path: candidate })
    }
  }
}

function decodeGitPath(pathBytes) {
  const decoded = pathBytes.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(pathBytes)) {
    throw new Error('Git tree contains a path that is not valid UTF-8.')
  }
  assertSafeRepositoryPath(decoded)
  return decoded
}

function parseTreeRecord(record) {
  const separator = record.indexOf(0x09)
  if (separator <= 0 || separator === record.length - 1) {
    throw new Error('Git returned a malformed ls-tree record.')
  }

  const header = record.subarray(0, separator).toString('ascii')
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40})$/u.exec(header)
  if (!match) throw new Error(`Git returned an unsupported ls-tree header: ${header}`)

  const [, mode, type, object] = match
  const path = decodeGitPath(record.subarray(separator + 1))
  if (mode === '120000' || (mode === '160000' && type === 'commit')) {
    throw new Error(`Symlinks and gitlinks are not supported in exact-commit staging: ${path}`)
  }
  if (!REGULAR_GIT_MODES.has(mode) || type !== 'blob' || !GIT_OBJECT_PATTERN.test(object)) {
    throw new Error(`Unsupported Git tree entry ${mode} ${type}: ${path}`)
  }
  return { mode, object, path }
}

function listCommitFiles(sourceCommit) {
  const output = runGit([
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceCommit,
    '--',
    ...EXACT_COMMIT_INPUT_PATHS,
  ])
  const entries = []
  let start = 0
  while (start < output.length) {
    const end = output.indexOf(0, start)
    if (end < 0) throw new Error('Git ls-tree output was not NUL terminated.')
    if (end === start) throw new Error('Git ls-tree output contained an empty record.')
    entries.push(parseTreeRecord(output.subarray(start, end)))
    start = end + 1
  }
  assertNoPortablePathCollisions(entries.map((entry) => entry.path))
  return entries
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function verifyGitBlob(object, contents, repositoryPath) {
  const calculatedObject = createHash('sha1')
    .update(`blob ${contents.length}\0`, 'utf8')
    .update(contents)
    .digest('hex')
  if (calculatedObject !== object) {
    throw new Error(`Git blob verification failed for ${repositoryPath}.`)
  }
}

function readGitBlob(entry) {
  const contents = runGit(['cat-file', 'blob', entry.object])
  verifyGitBlob(entry.object, contents, entry.path)
  return contents
}

function filesystemPath(root, repositoryPath) {
  const target = resolve(root, ...repositoryPath.split('/'))
  if (!isSameOrDescendant(root, target) || comparablePath(root) === comparablePath(target)) {
    throw new Error(`Repository path escapes its materialization root: ${repositoryPath}`)
  }
  return target
}

function materializeEntries(entries, outputRoot) {
  const records = []
  for (const entry of entries) {
    const contents = readGitBlob(entry)
    const outputPath = filesystemPath(outputRoot, entry.path)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, contents, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    })
    if (process.platform !== 'win32') {
      chmodSync(outputPath, entry.mode === '100755' ? 0o755 : 0o644)
    }
    records.push({
      gitObject: entry.object,
      mode: entry.mode,
      path: entry.path,
      sha256: sha256(contents),
      size: contents.length,
      source: 'tracked',
    })
  }
  return records
}

function requireTrackedFile(entriesByPath, path) {
  if (!entriesByPath.has(path)) throw new Error(`Required tracked file is missing: ${path}`)
}

function isInsideRepositoryDirectory(path, directory) {
  return path === directory || path.startsWith(`${directory}/`)
}

function isInsidePortableRepositoryDirectory(path, directory) {
  const pathKey = portablePathKey(path)
  const directoryKey = portablePathKey(directory)
  return pathKey === directoryKey || pathKey.startsWith(`${directoryKey}/`)
}

function isPluginInput(path) {
  return (
    PLUGIN_ROOT_FILES.includes(path) ||
    PLUGIN_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`))
  )
}

function isExcludedPluginJunk(path) {
  const components = path.split('/')
  const name = components.at(-1)
  return (
    components.includes('__pycache__') ||
    name === '.DS_Store' ||
    name.endsWith('.pyc') ||
    name.endsWith('.pyo')
  )
}

function compareRepositoryPaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function enumerateRegularFiles(root, repositoryPrefix = '') {
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${root}`)
  }

  const files = []
  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const repositoryPath = repositoryPrefix
        ? `${repositoryPrefix}/${relativePath}`
        : relativePath
      assertSafeRepositoryPath(repositoryPath)
      const absolutePath = join(directory, entry.name)
      const stat = lstatSync(absolutePath)
      if (stat.isSymbolicLink()) {
        throw new Error(`Generated or staged symlinks are not allowed: ${repositoryPath}`)
      }
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath)
      } else if (stat.isFile()) {
        files.push({ absolutePath, path: repositoryPath })
      } else {
        throw new Error(`Only regular files are allowed in staging: ${repositoryPath}`)
      }
    }
  }
  visit(root, '')
  assertNoPortablePathCollisions(files.map((file) => file.path))
  return files.sort(compareRepositoryPaths)
}

function overlayGeneratedWeb(buildRoot, pluginStage) {
  const generatedRoot = filesystemPath(buildRoot, GENERATED_WEB_DIRECTORY)
  if (!pathExists(generatedRoot)) {
    throw new Error(`Frontend build did not create ${GENERATED_WEB_DIRECTORY}.`)
  }

  const generatedFiles = enumerateRegularFiles(generatedRoot, GENERATED_WEB_DIRECTORY)
  if (!generatedFiles.some((file) => file.path === `${GENERATED_WEB_DIRECTORY}/index.html`)) {
    throw new Error(`Frontend build did not create ${GENERATED_WEB_DIRECTORY}/index.html.`)
  }

  const records = []
  for (const file of generatedFiles) {
    if (!isInsideRepositoryDirectory(file.path, GENERATED_WEB_DIRECTORY)) {
      throw new Error(`Generated file escaped ${GENERATED_WEB_DIRECTORY}: ${file.path}`)
    }
    const contents = readFileSync(file.absolutePath)
    const outputPath = filesystemPath(pluginStage, file.path)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, contents, { flag: 'wx', mode: 0o644 })
    if (process.platform !== 'win32') chmodSync(outputPath, 0o644)
    records.push({
      path: file.path,
      sha256: sha256(contents),
      size: contents.length,
      source: 'generated',
    })
  }
  return records
}

function assertStageMatchesManifest(pluginStage, files) {
  const stagedFiles = enumerateRegularFiles(pluginStage)
  const expectedPaths = files.map((file) => file.path)
  assertNoPortablePathCollisions(expectedPaths)
  const actualPaths = stagedFiles.map((file) => file.path)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Plugin stage file set differs from its manifest. Expected ${JSON.stringify(expectedPaths)}, received ${JSON.stringify(actualPaths)}.`,
    )
  }

  for (const [index, stagedFile] of stagedFiles.entries()) {
    const contents = readFileSync(stagedFile.absolutePath)
    const manifestFile = files[index]
    if (manifestFile.size !== contents.length || manifestFile.sha256 !== sha256(contents)) {
      throw new Error(`Plugin stage file does not match its manifest: ${stagedFile.path}`)
    }
    if (
      manifestFile.source === 'generated' &&
      !isInsideRepositoryDirectory(manifestFile.path, GENERATED_WEB_DIRECTORY)
    ) {
      throw new Error(`Generated manifest entry escaped ${GENERATED_WEB_DIRECTORY}: ${manifestFile.path}`)
    }
  }
}

function resolveExactCommit(sourceCommit) {
  if (
    typeof sourceCommit !== 'string' ||
    sourceCommit.length !== 40 ||
    !FULL_SHA_PATTERN.test(sourceCommit)
  ) {
    throw new Error('Source commit must be exactly 40 hexadecimal characters.')
  }
  const requestedCommit = sourceCommit.toLowerCase()
  const resolvedCommit = runGit([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${requestedCommit}^{commit}`,
  ]).toString('ascii').trim()
  if (!GIT_OBJECT_PATTERN.test(resolvedCommit) || resolvedCommit !== requestedCommit) {
    throw new Error(
      `Source commit must name that exact commit object; requested ${requestedCommit}, resolved ${resolvedCommit || '<empty>'}.`,
    )
  }
  return resolvedCommit
}

function assertRepositoryRoot() {
  const discoveredRoot = runGit(['rev-parse', '--show-toplevel']).toString('utf8').trim()
  if (!isSameFilesystemEntry(discoveredRoot, REPOSITORY_ROOT)) {
    throw new Error(
      `Staging script repository root mismatch: expected ${REPOSITORY_ROOT}, received ${discoveredRoot}.`,
    )
  }
}

function combineErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) return primaryError
  return new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    primaryError
      ? `${errorText(primaryError)} Cleanup also failed.`
      : 'Exact-commit staging cleanup failed.',
  )
}

export async function stagePluginFromCommit(sourceCommit, pluginStageInput, manifestPathInput) {
  assertRepositoryRoot()
  const repositoryRoot = realpathSync(REPOSITORY_ROOT)
  const pluginStage = canonicalFreshOutputPath(
    pluginStageInput,
    'Plugin stage',
    repositoryRoot,
  )
  const manifestPath = canonicalFreshOutputPath(
    manifestPathInput,
    'Manifest path',
    repositoryRoot,
  )
  assertIndependentOutputs(pluginStage, manifestPath)

  const resolvedCommit = resolveExactCommit(sourceCommit)
  const commitEntries = listCommitFiles(resolvedCommit)
  const entriesByPath = new Map(commitEntries.map((entry) => [entry.path, entry]))
  for (const path of [
    ...PLUGIN_ROOT_FILES,
    'frontend/.npmrc',
    'frontend/package-lock.json',
    'frontend/package.json',
    'scripts/validate-node-version.mjs',
    'scripts/validate-npm-lock-registry.mjs',
    'tests/fixtures/command-schema-v1.json',
  ]) {
    requireTrackedFile(entriesByPath, path)
  }

  const trackedDist = commitEntries.filter((entry) =>
    isInsidePortableRepositoryDirectory(entry.path, GENERATED_WEB_DIRECTORY),
  )
  if (trackedDist.length > 0) {
    throw new Error(
      `${GENERATED_WEB_DIRECTORY} must be generated and untracked; found ${trackedDist[0].path}.`,
    )
  }

  const pluginDirectoryBlobs = commitEntries.filter((entry) =>
    PLUGIN_DIRECTORIES.includes(entry.path),
  )
  if (pluginDirectoryBlobs.length > 0) {
    throw new Error(
      `Plugin directory path must be a tree, not a tracked file: ${pluginDirectoryBlobs[0].path}.`,
    )
  }

  const excludedJunk = commitEntries.filter(
    (entry) => isPluginInput(entry.path) && isExcludedPluginJunk(entry.path),
  )
  if (excludedJunk.length > 0) {
    throw new Error(`Tracked packaging junk is not allowed: ${excludedJunk[0].path}`)
  }

  const pluginEntries = commitEntries.filter((entry) => isPluginInput(entry.path))
  const stageParent = dirname(pluginStage)
  let buildRoot
  let stageCreated = false
  let manifestCreated = false
  let result
  let primaryError

  try {
    buildRoot = mkdtempSync(join(stageParent, '.unreal-editor-webui-build-'))
    if (isExistingPathInside(repositoryRoot, buildRoot)) {
      throw new Error(`Temporary build tree must be outside the repository: ${buildRoot}`)
    }
    const npmLauncher = resolveNpmLauncher([repositoryRoot, realpathSync.native(buildRoot)])
    materializeEntries(commitEntries, buildRoot)

    const frontendDirectory = filesystemPath(buildRoot, 'frontend')
    const generatedRoot = filesystemPath(buildRoot, GENERATED_WEB_DIRECTORY)
    if (pathExists(generatedRoot)) {
      throw new Error(`${GENERATED_WEB_DIRECTORY} unexpectedly existed before the frontend build.`)
    }

    await validateExactBuildInputs(buildRoot)

    const buildToolchain = {
      nodeVersion: process.versions.node,
      nodeArchitecture: process.arch,
      npmVersion: readExactNpmVersion(npmLauncher, frontendDirectory),
    }
    runNpm(npmLauncher, ['ci'], frontendDirectory, 'Exact-commit dependency installation')
    if (pathExists(generatedRoot)) {
      throw new Error(
        `${GENERATED_WEB_DIRECTORY} must be created by the frontend build, not dependency installation.`,
      )
    }
    runNpm(npmLauncher, ['run', 'build'], frontendDirectory, 'Exact-commit frontend build')

    mkdirSync(pluginStage)
    stageCreated = true
    const trackedFiles = materializeEntries(pluginEntries, pluginStage)
    const generatedFiles = overlayGeneratedWeb(buildRoot, pluginStage)
    const files = [...trackedFiles, ...generatedFiles].sort(compareRepositoryPaths)
    assertStageMatchesManifest(pluginStage, files)

    const manifest = {
      schemaVersion: 1,
      sourceCommit: resolvedCommit,
      buildToolchain,
      files,
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    })
    manifestCreated = true
    const persistedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (JSON.stringify(persistedManifest) !== JSON.stringify(manifest)) {
      throw new Error('Persisted pre-UBT manifest does not match the validated manifest.')
    }

    result = { manifest, manifestPath, pluginStage, sourceCommit: resolvedCommit }
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  if (buildRoot !== undefined) {
    try {
      rmSync(buildRoot, { force: true, recursive: true })
    } catch (error) {
      cleanupErrors.push(new Error(`Unable to remove temporary build tree: ${errorText(error)}`))
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    if (manifestCreated) {
      try {
        unlinkSync(manifestPath)
      } catch (error) {
        cleanupErrors.push(new Error(`Unable to remove failed manifest: ${errorText(error)}`))
      }
    }
    if (stageCreated) {
      try {
        rmSync(pluginStage, { force: true, recursive: true })
      } catch (error) {
        cleanupErrors.push(new Error(`Unable to remove failed plugin stage: ${errorText(error)}`))
      }
    }
    throw combineErrors(primaryError, cleanupErrors)
  }

  return result
}

async function runCli() {
  const args = process.argv.slice(2)
  if (args.length !== 3) {
    console.error(
      'Usage: node scripts/stage-plugin-from-commit.mjs <sourceCommit> <pluginStage> <manifestPath>',
    )
    process.exitCode = 2
    return
  }

  try {
    const result = await stagePluginFromCommit(args[0], args[1], args[2])
    console.log(
      `Staged ${result.manifest.files.length} files from exact commit ${result.sourceCommit}.`,
    )
  } catch (error) {
    console.error(`Exact-commit plugin staging failed: ${errorText(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
