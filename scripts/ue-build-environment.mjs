import {
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path'
import { pathToFileURL } from 'node:url'

import { isSupportedNodeVersion } from './validate-node-version.mjs'
import {
  RELEASE_VARIANTS,
  requireReleaseVariant,
} from './ue-release-variants.mjs'

export const BUILD_ENVIRONMENT_SCHEMA_VERSION = 2
export const EXPECTED_WORKFLOW_PATH = '.github/workflows/ue-ci.yml'
export const EXPECTED_WORKFLOW_NAME = 'UE CI'
export const EXPECTED_JOB_KEY = 'buildplugin-and-automation'
export const EXPECTED_JOB_NAME = requireReleaseVariant('ue58').jobName
export const EXPECTED_PACKAGE_ARTIFACT_NAME =
  requireReleaseVariant('ue58').packageArtifactName
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const STABLE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SDK_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const UBA_LOG_NAME_PATTERN = /^UBA-.+\.txt$/iu

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'releaseVariant',
  'buildId',
  'repository',
  'sourceCommit',
  'workflow',
  'unrealEngine',
  'compiler',
  'windowsSdk',
  'frontend',
  'runtime',
  'packageArtifact',
])
const WORKFLOW_KEYS = Object.freeze([
  'path',
  'name',
  'runId',
  'runAttempt',
  'jobKey',
  'jobName',
])
const ENGINE_KEYS = Object.freeze([
  'majorVersion',
  'minorVersion',
  'patchVersion',
  'changelist',
  'compatibleChangelist',
  'branchName',
  'isLicenseeVersion',
  'isPromotedBuild',
])
const COMPILER_KEYS = Object.freeze([
  'kind',
  'visualStudioVersion',
  'toolchainFamilyVersion',
  'compilerProductVersion',
  'hostArchitecture',
  'targetArchitecture',
])
const WINDOWS_SDK_KEYS = Object.freeze(['version', 'architecture'])
const FRONTEND_KEYS = Object.freeze(['nodeVersion', 'nodeArchitecture', 'npmVersion'])
const RUNTIME_KEYS = Object.freeze([
  'embeddedPythonVersion',
  'cefProductVersion',
  'cefChromiumVersion',
])
const PACKAGE_ARTIFACT_KEYS = Object.freeze([
  'artifactId',
  'artifactName',
  'artifactDigest',
])

function fail(message) {
  throw new Error(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`)
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} contains an unexpected or missing field.`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(`${label} must be a non-empty string.`)
  }
  return value
}

function requireSafePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a safe positive integer.`)
  }
  return value
}

function parseSafePositiveInteger(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    fail(`${label} must be a safe positive integer.`)
  }
  const parsed = Number(value)
  return requireSafePositiveInteger(parsed, label)
}

function requireSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a safe non-negative integer.`)
  }
  return value
}

function requireCompatibleChangelist(value, changelist, label) {
  const compatibleChangelist = requireSafeNonNegativeInteger(value, label)
  if (compatibleChangelist !== 0 && compatibleChangelist > changelist) {
    fail(`${label} must be zero or no greater than the UE changelist.`)
  }
  return compatibleChangelist
}

function requireStableVersion(value, label) {
  if (typeof value !== 'string' || !STABLE_VERSION_PATTERN.test(value)) {
    fail(`${label} must be a stable semantic version.`)
  }
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) {
    fail(`${label} must be a stable semantic version.`)
  }
  return { value, parts }
}

function requireSdkVersion(value, label) {
  if (typeof value !== 'string' || !SDK_VERSION_PATTERN.test(value)) {
    fail(`${label} must contain four numeric components.`)
  }
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger) || parts[0] !== 10 || parts[1] !== 0) {
    fail(`${label} is not an accepted Windows SDK version.`)
  }
  return { value, parts }
}

function compareVersionParts(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function inferVisualStudioVersion(productParts) {
  if (
    productParts[0] === 14 &&
    [38, 44].includes(productParts[1])
  ) return '2022'
  if (productParts[0] === 14 && productParts[1] === 50) return '2026'
  fail('The selected compiler family is not recognized for release evidence.')
}

function validateCompilerPolicy(visualStudioVersion, familyVersion, productVersion, variant) {
  const family = requireStableVersion(familyVersion, 'Toolchain family version')
  const product = requireStableVersion(productVersion, 'Compiler product version')
  const inferredVersion = inferVisualStudioVersion(product.parts)
  if (visualStudioVersion !== inferredVersion) {
    fail('The Visual Studio release does not match the selected compiler family.')
  }
  if (
    visualStudioVersion !== variant.toolchain.visualStudioVersion ||
    family.value !== variant.toolchain.familyVersion ||
    product.value !== variant.toolchain.productVersion ||
    product.parts[0] !== family.parts[0] ||
    product.parts[1] !== family.parts[1]
  ) {
    fail(`The selected compiler does not satisfy the exact ${variant.releaseVariant} policy.`)
  }
  return { family: family.value, product: product.value }
}

function decodeText(buffer, label) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    fail(`${label} uses an unsupported text encoding.`)
  }
  const start =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? 3
      : 0
  return buffer.subarray(start).toString('utf8')
}

function readText(path, label) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    fail(`${label} is missing or unreadable.`)
  }
  if (!stat.isFile()) fail(`${label} must be a regular file.`)
  try {
    return decodeText(readFileSync(path), label)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error
    fail(`${label} is missing or unreadable.`)
  }
}

function readJson(path, label) {
  const text = readText(path, label)
  try {
    return JSON.parse(text)
  } catch {
    fail(`${label} is not valid JSON.`)
  }
}

function comparableNativePath(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isSameOrDescendant(parent, child) {
  const childRelative = relative(comparableNativePath(parent), comparableNativePath(child))
  return (
    childRelative === '' ||
    (childRelative !== '..' &&
      !childRelative.startsWith(`..${sep}`) &&
      !isAbsolute(childRelative))
  )
}

function extractReferencedUbaLogs(consoleLogPath, logDirectoryPath) {
  let directoryStat
  try {
    directoryStat = statSync(logDirectoryPath)
  } catch {
    fail('The AutomationTool log directory is missing or unreadable.')
  }
  if (!directoryStat.isDirectory()) fail('The AutomationTool log directory must be a directory.')

  let canonicalDirectory
  try {
    canonicalDirectory = realpathSync.native(logDirectoryPath)
  } catch {
    fail('The AutomationTool log directory is missing or unreadable.')
  }

  const consoleText = readText(consoleLogPath, 'BuildPlugin console log')
  const referencePattern = /(?:^|\s)-log=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s\r\n]+))/gu
  const references = []
  for (const line of consoleText.split(/\r\n?|\n/u)) {
    if (!/(?:^|\s)Running:\s/u.test(line) || !/UnrealBuildTool\.dll(?:["']|\s)/iu.test(line)) {
      continue
    }
    for (const match of line.matchAll(referencePattern)) {
      references.push(match[1] ?? match[2] ?? match[3])
    }
  }
  if (references.length === 0) {
    fail('The BuildPlugin console log does not reference a UBT log.')
  }

  const uniquePaths = new Map()
  for (const reference of references) {
    if (!isAbsolute(reference) || reference.includes('\0')) {
      fail('A BuildPlugin UBT log reference is not an absolute path.')
    }
    let canonicalReference
    let referenceStat
    try {
      canonicalReference = realpathSync.native(reference)
      referenceStat = statSync(canonicalReference)
    } catch {
      fail('A referenced BuildPlugin UBT log is missing or unreadable.')
    }
    if (
      !isSameOrDescendant(canonicalDirectory, canonicalReference) ||
      !referenceStat.isFile() ||
      !UBA_LOG_NAME_PATTERN.test(basename(canonicalReference))
    ) {
      fail('A referenced BuildPlugin UBT log is outside the scoped UBA log set.')
    }
    uniquePaths.set(comparableNativePath(canonicalReference), canonicalReference)
  }
  return [...uniquePaths.values()]
}

function normalizeWindowsPath(value, label) {
  const trimmed = requireString(value, label).trim()
  if (!win32.isAbsolute(trimmed)) fail(`${label} must be an absolute Windows path.`)
  return win32.normalize(trimmed).replace(/[\\/]+$/u, '')
}

function comparableWindowsPath(value) {
  return win32.normalize(value).replace(/[\\/]+$/u, '').toLowerCase()
}

function parseUsingSelection(match) {
  const explicitVisualStudioVersion = match[1] || null
  const compilerProductVersion = match[2]
  const toolchainRoot = normalizeWindowsPath(match[3], 'Selected toolchain path')
  const windowsSdkVersion = match[4]
  const windowsSdkRoot = normalizeWindowsPath(match[5], 'Selected Windows SDK path')
  const toolchainMatch = /^(.*\\VC\\Tools\\MSVC\\((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)))$/iu.exec(
    toolchainRoot,
  )
  if (!toolchainMatch) fail('The selected toolchain path has an unexpected shape.')

  const sdkMatch = /^(.*\\Windows Kits\\10)$/iu.exec(windowsSdkRoot)
  if (!sdkMatch) fail('The selected Windows SDK path has an unexpected shape.')
  requireSdkVersion(windowsSdkVersion, 'Selected Windows SDK version')

  const product = requireStableVersion(compilerProductVersion, 'Compiler product version')
  const inferredVisualStudioVersion = inferVisualStudioVersion(product.parts)
  if (
    explicitVisualStudioVersion !== null &&
    explicitVisualStudioVersion !== inferredVisualStudioVersion
  ) {
    fail('The explicit Visual Studio release does not match the compiler family.')
  }
  const visualStudioVersion = explicitVisualStudioVersion ?? inferredVisualStudioVersion
  const family = requireStableVersion(toolchainMatch[2], 'Toolchain family version')
  if (family.parts[0] !== product.parts[0] || family.parts[1] !== product.parts[1]) {
    fail('The compiler product and toolchain family versions do not match.')
  }

  return {
    visualStudioVersion,
    toolchainFamilyVersion: family.value,
    compilerProductVersion: product.value,
    toolchainRoot: comparableWindowsPath(toolchainMatch[1]),
    windowsSdkVersion,
    windowsSdkRoot: comparableWindowsPath(sdkMatch[1]),
  }
}

function parseCompilerSelection(pathValue) {
  const compilerPath = normalizeWindowsPath(pathValue, 'Compiler path')
  const match = /^(.*\\VC\\Tools\\MSVC\\((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)))\\bin\\Host(x64|arm64)\\(x64|arm64)\\cl\.exe$/iu.exec(
    compilerPath,
  )
  if (!match) fail('The compiler path has an unexpected shape.')
  return {
    toolchainRoot: comparableWindowsPath(match[1]),
    toolchainFamilyVersion: match[2],
    hostArchitecture: match[3].toLowerCase(),
    targetArchitecture: match[4].toLowerCase(),
  }
}

function parseResourceCompilerSelection(pathValue) {
  const resourceCompilerPath = normalizeWindowsPath(pathValue, 'Resource compiler path')
  const match = /^(.*\\Windows Kits\\10)\\bin\\((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\\(x64|arm64)\\rc\.exe$/iu.exec(
    resourceCompilerPath,
  )
  if (!match) fail('The resource compiler path has an unexpected shape.')
  requireSdkVersion(match[2], 'Resource compiler Windows SDK version')
  return {
    windowsSdkRoot: comparableWindowsPath(match[1]),
    windowsSdkVersion: match[2],
    architecture: match[3].toLowerCase(),
  }
}

function uniqueSelection(records, label) {
  if (records.length === 0) fail(`A referenced UBT log is missing its ${label} selection.`)
  const unique = new Map(records.map((record) => [JSON.stringify(record), record]))
  if (unique.size !== 1) fail(`A referenced UBT log contains conflicting ${label} selections.`)
  return unique.values().next().value
}

function parseUbaLog(path) {
  const text = readText(path, 'Referenced UBT log')
  const usingSelections = []
  const compilerSelections = []
  const resourceCompilerSelections = []

  for (const line of text.split(/\r\n?|\n/u)) {
    const usingMatch = /Using Visual Studio(?: (2022|2026))? ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) toolchain \((.+)\) and Windows ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) SDK \((.+)\)\.?/u.exec(
      line,
    )
    if (usingMatch) usingSelections.push(parseUsingSelection(usingMatch))

    const resourceCompilerMatch = /Resource Compiler:\s*(.+?\\rc\.exe)\s*$/iu.exec(line)
    if (resourceCompilerMatch) {
      resourceCompilerSelections.push(parseResourceCompilerSelection(resourceCompilerMatch[1]))
    }

    const compilerMatch = /(?:^|\s)Compiler:\s*(.+?\\cl\.exe)\s*$/iu.exec(line)
    if (compilerMatch) compilerSelections.push(parseCompilerSelection(compilerMatch[1]))
  }

  const using = uniqueSelection(usingSelections, 'toolchain and SDK')
  const compiler = uniqueSelection(compilerSelections, 'compiler')
  const resourceCompiler = uniqueSelection(resourceCompilerSelections, 'resource compiler')
  if (
    using.toolchainRoot !== compiler.toolchainRoot ||
    using.toolchainFamilyVersion !== compiler.toolchainFamilyVersion ||
    using.windowsSdkRoot !== resourceCompiler.windowsSdkRoot ||
    using.windowsSdkVersion !== resourceCompiler.windowsSdkVersion
  ) {
    fail('A referenced UBT log contains inconsistent toolchain or SDK selections.')
  }
  if (
    compiler.hostArchitecture !== 'x64' ||
    compiler.targetArchitecture !== 'x64' ||
    resourceCompiler.architecture !== 'x64'
  ) {
    fail('UE release evidence requires x64 host, target, and SDK tools.')
  }

  return {
    compiler: {
      kind: 'msvc',
      visualStudioVersion: using.visualStudioVersion,
      toolchainFamilyVersion: using.toolchainFamilyVersion,
      compilerProductVersion: using.compilerProductVersion,
      hostArchitecture: compiler.hostArchitecture,
      targetArchitecture: compiler.targetArchitecture,
    },
    windowsSdk: {
      version: using.windowsSdkVersion,
      architecture: resourceCompiler.architecture,
    },
    internalSelection: {
      toolchainRoot: using.toolchainRoot,
      windowsSdkRoot: using.windowsSdkRoot,
    },
  }
}

export function collectUbtBuildEnvironment(consoleLogPath, logDirectoryPath) {
  const referencedLogs = extractReferencedUbaLogs(consoleLogPath, logDirectoryPath)
  const selections = referencedLogs.map(parseUbaLog)
  const unique = new Map(selections.map((selection) => [JSON.stringify(selection), selection]))
  if (unique.size !== 1) {
    fail('The referenced UBT logs contain conflicting complete build-environment selections.')
  }
  const selected = unique.values().next().value
  return {
    compiler: selected.compiler,
    windowsSdk: selected.windowsSdk,
  }
}

function parseBuildVersion(path, variant) {
  const value = readJson(path, 'UE Build.version')
  if (!isRecord(value)) fail('UE Build.version must contain an object.')
  const majorVersion = requireSafeNonNegativeInteger(value.MajorVersion, 'UE major version')
  const minorVersion = requireSafeNonNegativeInteger(value.MinorVersion, 'UE minor version')
  const patchVersion = requireSafeNonNegativeInteger(value.PatchVersion, 'UE patch version')
  const changelist = requireSafePositiveInteger(value.Changelist, 'UE changelist')
  const compatibleChangelist = requireCompatibleChangelist(
    value.CompatibleChangelist,
    changelist,
    'UE compatible changelist',
  )
  const branchName = requireString(value.BranchName, 'UE branch name')
  if (
    majorVersion !== variant.engine.majorVersion ||
    minorVersion !== variant.engine.minorVersion ||
    patchVersion !== variant.engine.patchVersion ||
    changelist !== variant.engine.changelist ||
    compatibleChangelist !== variant.engine.compatibleChangelist ||
    branchName !== variant.engine.branchName ||
    value.IsLicenseeVersion !== 0 ||
    value.IsPromotedBuild !== 1
  ) {
    fail(`UE Build.version does not identify the exact ${variant.releaseVariant} build.`)
  }
  return {
    majorVersion,
    minorVersion,
    patchVersion,
    changelist,
    compatibleChangelist,
    branchName,
    isLicenseeVersion: false,
    isPromotedBuild: true,
  }
}

function parseEditorVersion(path, variant) {
  const value = readJson(path, 'UE UnrealEditor.version')
  if (!isRecord(value)) fail('UE UnrealEditor.version must contain an object.')
  const expected = variant.engine
  if (
    value.MajorVersion !== expected.majorVersion ||
    value.MinorVersion !== expected.minorVersion ||
    value.PatchVersion !== expected.patchVersion ||
    value.Changelist !== expected.changelist ||
    value.CompatibleChangelist !== expected.compatibleChangelist ||
    value.BranchName !== expected.branchName ||
    value.BuildId !== expected.buildId ||
    value.IsLicenseeVersion !== 0 ||
    value.IsPromotedBuild !== 1
  ) {
    fail(`UE UnrealEditor.version does not identify the exact ${variant.releaseVariant} build.`)
  }
  return value.BuildId
}

function parsePackageBuildId(packageDirectoryPath, variant) {
  const binariesDirectory = resolve(packageDirectoryPath, 'Binaries', 'Win64')
  let canonicalPackageDirectory
  let canonicalBinariesDirectory
  try {
    canonicalPackageDirectory = realpathSync.native(resolve(packageDirectoryPath))
    canonicalBinariesDirectory = realpathSync.native(binariesDirectory)
  } catch {
    fail('Packaged plugin Win64 binaries directory is missing or unreadable.')
  }
  if (!isSameOrDescendant(canonicalPackageDirectory, canonicalBinariesDirectory)) {
    fail('Packaged plugin binaries resolve outside the package directory.')
  }
  const descriptorPath = resolve(canonicalPackageDirectory, 'UnrealEditorWebUI.uplugin')
  let descriptorStat
  try {
    descriptorStat = lstatSync(descriptorPath)
  } catch {
    fail('Packaged plugin descriptor is missing or unreadable.')
  }
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) {
    fail('Packaged plugin descriptor must be a regular non-symbolic file.')
  }
  const descriptor = readJson(descriptorPath, 'Packaged plugin descriptor')
  if (
    !isRecord(descriptor) ||
    descriptor.Installed !== true ||
    descriptor.EngineVersion !== `${variant.engineAssociation}.0`
  ) {
    fail(`Packaged plugin descriptor does not identify ${variant.releaseVariant}.`)
  }
  const moduleFiles = readdirSync(canonicalBinariesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.modules'))
    .map((entry) => resolve(canonicalBinariesDirectory, entry.name))
  if (moduleFiles.length !== 1) {
    fail('The package must contain exactly one Win64 module manifest.')
  }
  const matching = []
  for (const modulePath of moduleFiles) {
    const document = readJson(modulePath, 'Packaged plugin module manifest')
    if (
      isRecord(document) &&
      isRecord(document.Modules) &&
      Object.hasOwn(document.Modules, 'UnrealEditorWebUI')
    ) {
      matching.push(document)
    }
  }
  if (matching.length !== 1) {
    fail('The package must contain exactly one module manifest for UnrealEditorWebUI.')
  }
  const moduleNames = Object.keys(matching[0].Modules)
  if (
    moduleNames.length !== 1 ||
    moduleNames[0] !== 'UnrealEditorWebUI' ||
    matching[0].Modules.UnrealEditorWebUI !== 'UnrealEditor-UnrealEditorWebUI.dll'
  ) {
    fail('The packaged module manifest contains an unexpected module mapping.')
  }
  const moduleBinaryPath = resolve(
    canonicalBinariesDirectory,
    matching[0].Modules.UnrealEditorWebUI,
  )
  let moduleBinaryStat
  let canonicalModuleBinaryPath
  try {
    moduleBinaryStat = lstatSync(moduleBinaryPath)
    canonicalModuleBinaryPath = realpathSync.native(moduleBinaryPath)
  } catch {
    fail('The packaged UnrealEditorWebUI module binary is missing or unreadable.')
  }
  if (
    !isSameOrDescendant(canonicalBinariesDirectory, canonicalModuleBinaryPath) ||
    !moduleBinaryStat.isFile() ||
    moduleBinaryStat.isSymbolicLink() ||
    moduleBinaryStat.size <= 0
  ) {
    fail('The packaged UnrealEditorWebUI module binary is invalid.')
  }
  if (matching[0].BuildId !== variant.engine.buildId) {
    fail(`Packaged plugin BuildId does not match ${variant.releaseVariant}.`)
  }
  return matching[0].BuildId
}

function parseSourceManifest(path, expectedCommit, expectedNodeArchitecture) {
  const manifest = readJson(path, 'Packaged source manifest')
  assertExactKeys(
    manifest,
    ['schemaVersion', 'sourceCommit', 'buildToolchain', 'files'],
    'Packaged source manifest',
  )
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceCommit !== expectedCommit ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail('Packaged source manifest identity is invalid.')
  }
  assertExactKeys(manifest.buildToolchain, FRONTEND_KEYS, 'Packaged build toolchain')
  const nodeVersion = requireStableVersion(
    manifest.buildToolchain.nodeVersion,
    'Packaged Node.js version',
  ).value
  if (!isSupportedNodeVersion(nodeVersion)) {
    fail('Packaged Node.js version does not satisfy the repository engine policy.')
  }
  const nodeArchitecture = requireString(
    manifest.buildToolchain.nodeArchitecture,
    'Packaged Node.js architecture',
  )
  if (
    nodeArchitecture !== 'x64' ||
    (expectedNodeArchitecture && nodeArchitecture !== expectedNodeArchitecture)
  ) {
    fail('Packaged Node.js architecture does not match the x64 build environment.')
  }
  const npmVersion = requireStableVersion(
    manifest.buildToolchain.npmVersion,
    'Packaged npm version',
  ).value
  return { nodeVersion, nodeArchitecture, npmVersion }
}

function validateRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    fail('Repository must be a GitHub owner/repository name.')
  }
  return value
}

function validateCommit(value) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail('Source commit must be a canonical lowercase 40-character SHA.')
  }
  return value
}

function validateWorkflow(value, variant) {
  assertExactKeys(value, WORKFLOW_KEYS, 'Build-environment workflow')
  if (
    value.path !== EXPECTED_WORKFLOW_PATH ||
    value.name !== EXPECTED_WORKFLOW_NAME ||
    value.jobKey !== EXPECTED_JOB_KEY ||
    value.jobName !== variant.jobName
  ) {
    fail('Build-environment workflow identity is invalid.')
  }
  return {
    path: value.path,
    name: value.name,
    runId: requireSafePositiveInteger(value.runId, 'Workflow run id'),
    runAttempt: requireSafePositiveInteger(value.runAttempt, 'Workflow run attempt'),
    jobKey: value.jobKey,
    jobName: value.jobName,
  }
}

function validateEngine(value, variant) {
  assertExactKeys(value, ENGINE_KEYS, 'Build-environment Unreal Engine')
  const changelist = requireSafePositiveInteger(value.changelist, 'UE changelist')
  const compatibleChangelist = requireCompatibleChangelist(
    value.compatibleChangelist,
    changelist,
    'UE compatible changelist',
  )
  if (
    value.majorVersion !== variant.engine.majorVersion ||
    value.minorVersion !== variant.engine.minorVersion ||
    value.patchVersion !== variant.engine.patchVersion ||
    value.changelist !== variant.engine.changelist ||
    value.compatibleChangelist !== variant.engine.compatibleChangelist ||
    value.branchName !== variant.engine.branchName ||
    value.isLicenseeVersion !== false ||
    value.isPromotedBuild !== true
  ) {
    fail('Build-environment Unreal Engine identity is invalid.')
  }
  return {
    majorVersion: value.majorVersion,
    minorVersion: value.minorVersion,
    patchVersion: requireSafeNonNegativeInteger(value.patchVersion, 'UE patch version'),
    changelist,
    compatibleChangelist,
    branchName: value.branchName,
    isLicenseeVersion: value.isLicenseeVersion,
    isPromotedBuild: value.isPromotedBuild,
  }
}

function validateCompiler(value, variant) {
  assertExactKeys(value, COMPILER_KEYS, 'Build-environment compiler')
  if (
    value.kind !== 'msvc' ||
    value.hostArchitecture !== 'x64' ||
    value.targetArchitecture !== 'x64'
  ) {
    fail('Build-environment compiler identity is invalid.')
  }
  const versions = validateCompilerPolicy(
    value.visualStudioVersion,
    value.toolchainFamilyVersion,
    value.compilerProductVersion,
    variant,
  )
  return {
    kind: value.kind,
    visualStudioVersion: value.visualStudioVersion,
    toolchainFamilyVersion: versions.family,
    compilerProductVersion: versions.product,
    hostArchitecture: value.hostArchitecture,
    targetArchitecture: value.targetArchitecture,
  }
}

function validateWindowsSdk(value, variant) {
  assertExactKeys(value, WINDOWS_SDK_KEYS, 'Build-environment Windows SDK')
  const version = requireSdkVersion(value.version, 'Build-environment Windows SDK version').value
  if (
    value.architecture !== 'x64' ||
    version !== variant.toolchain.windowsSdkVersion
  ) fail(`Build-environment Windows SDK does not match ${variant.releaseVariant}.`)
  return { version, architecture: value.architecture }
}

function validateFrontend(value) {
  assertExactKeys(value, FRONTEND_KEYS, 'Build-environment frontend')
  const nodeVersion = requireStableVersion(value.nodeVersion, 'Frontend Node.js version').value
  if (!isSupportedNodeVersion(nodeVersion)) {
    fail('Frontend Node.js version does not satisfy the repository engine policy.')
  }
  if (value.nodeArchitecture !== 'x64') fail('Frontend Node.js architecture is invalid.')
  const npmVersion = requireStableVersion(value.npmVersion, 'Frontend npm version').value
  return { nodeVersion, nodeArchitecture: value.nodeArchitecture, npmVersion }
}

function validateRuntime(value, variant) {
  assertExactKeys(value, RUNTIME_KEYS, 'Build-environment embedded runtime')
  if (
    value.embeddedPythonVersion !== variant.embeddedPythonVersion ||
    value.cefProductVersion !== variant.cefProductVersion ||
    value.cefChromiumVersion !== variant.cefChromiumVersion
  ) {
    fail(`Build-environment embedded runtime does not match ${variant.releaseVariant}.`)
  }
  return {
    embeddedPythonVersion: value.embeddedPythonVersion,
    cefProductVersion: value.cefProductVersion,
    cefChromiumVersion: value.cefChromiumVersion,
  }
}

function validatePackageArtifact(value, variant) {
  assertExactKeys(value, PACKAGE_ARTIFACT_KEYS, 'Build-environment package artifact')
  if (
    value.artifactName !== variant.packageArtifactName ||
    typeof value.artifactDigest !== 'string' ||
    !SHA256_PATTERN.test(value.artifactDigest)
  ) {
    fail('Build-environment package artifact identity is invalid.')
  }
  return {
    artifactId: requireSafePositiveInteger(value.artifactId, 'Package artifact id'),
    artifactName: value.artifactName,
    artifactDigest: value.artifactDigest,
  }
}

function expectedBindingMismatch(document, expected) {
  return (
    (expected.releaseVariant !== undefined &&
      document.releaseVariant !== expected.releaseVariant) ||
    (expected.buildId !== undefined && document.buildId !== expected.buildId) ||
    (expected.repository !== undefined && document.repository !== expected.repository) ||
    (expected.sourceCommit !== undefined && document.sourceCommit !== expected.sourceCommit) ||
    (expected.runId !== undefined && document.workflow.runId !== expected.runId) ||
    (expected.runAttempt !== undefined &&
      document.workflow.runAttempt !== expected.runAttempt) ||
    (expected.jobKey !== undefined && document.workflow.jobKey !== expected.jobKey) ||
    (expected.artifactId !== undefined &&
      document.packageArtifact.artifactId !== expected.artifactId) ||
    (expected.artifactName !== undefined &&
      document.packageArtifact.artifactName !== expected.artifactName) ||
    (expected.artifactDigest !== undefined &&
      document.packageArtifact.artifactDigest !== expected.artifactDigest)
  )
}

export function validateBuildEnvironment(value, expectedBindings = {}) {
  assertExactKeys(value, TOP_LEVEL_KEYS, 'Build environment')
  if (value.schemaVersion !== BUILD_ENVIRONMENT_SCHEMA_VERSION) {
    fail('Build environment schema version is unsupported.')
  }
  const variant = RELEASE_VARIANTS.find(
    (candidate) => candidate.releaseVariant === value.releaseVariant,
  )
  if (!variant || value.buildId !== variant.engine.buildId) {
    fail('Build environment release variant or BuildId is invalid.')
  }
  const rebuilt = {
    schemaVersion: BUILD_ENVIRONMENT_SCHEMA_VERSION,
    releaseVariant: variant.releaseVariant,
    buildId: variant.engine.buildId,
    repository: validateRepository(value.repository),
    sourceCommit: validateCommit(value.sourceCommit),
    workflow: validateWorkflow(value.workflow, variant),
    unrealEngine: validateEngine(value.unrealEngine, variant),
    compiler: validateCompiler(value.compiler, variant),
    windowsSdk: validateWindowsSdk(value.windowsSdk, variant),
    frontend: validateFrontend(value.frontend),
    runtime: validateRuntime(value.runtime, variant),
    packageArtifact: validatePackageArtifact(value.packageArtifact, variant),
  }
  if (expectedBindingMismatch(rebuilt, expectedBindings)) {
    fail('Build-environment subject does not match the expected release bindings.')
  }
  return rebuilt
}

export function createBuildEnvironment({
  consoleLogPath,
  logDirectoryPath,
  buildVersionPath,
  editorVersionPath,
  sourceManifestPath,
  repository,
  sourceCommit,
  runId,
  runAttempt,
  jobKey,
  jobName,
  workflowPath = EXPECTED_WORKFLOW_PATH,
  workflowName = EXPECTED_WORKFLOW_NAME,
  expectedNodeArchitecture,
  packageArtifactId,
  packageArtifactName,
  packageArtifactDigest,
  packageDirectoryPath,
  variantId,
  embeddedPythonVersion,
  cefProductVersion,
  cefChromiumVersion,
}) {
  const variant = requireReleaseVariant(variantId)
  const editorBuildId = parseEditorVersion(editorVersionPath, variant)
  const packageBuildId = parsePackageBuildId(packageDirectoryPath, variant)
  if (editorBuildId !== packageBuildId) {
    fail('Packaged plugin BuildId does not match the selected Unreal Editor BuildId.')
  }
  const canonicalRepository = validateRepository(repository)
  const canonicalCommit = validateCommit(sourceCommit)
  const workflow = validateWorkflow({
    path: workflowPath,
    name: workflowName,
    runId,
    runAttempt,
    jobKey,
    jobName,
  }, variant)
  const frontend = parseSourceManifest(
    sourceManifestPath,
    canonicalCommit,
    expectedNodeArchitecture,
  )
  const selected = collectUbtBuildEnvironment(consoleLogPath, logDirectoryPath)
  return validateBuildEnvironment({
    schemaVersion: BUILD_ENVIRONMENT_SCHEMA_VERSION,
    releaseVariant: variant.releaseVariant,
    buildId: editorBuildId,
    repository: canonicalRepository,
    sourceCommit: canonicalCommit,
    workflow,
    unrealEngine: parseBuildVersion(buildVersionPath, variant),
    compiler: selected.compiler,
    windowsSdk: selected.windowsSdk,
    frontend,
    runtime: {
      embeddedPythonVersion,
      cefProductVersion,
      cefChromiumVersion,
    },
    packageArtifact: {
      artifactId: packageArtifactId,
      artifactName: packageArtifactName,
      artifactDigest: packageArtifactDigest,
    },
  })
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writeFreshJson(path, value, label) {
  const parent = dirname(resolve(path))
  let parentStat
  try {
    parentStat = statSync(parent)
  } catch {
    fail(`${label} parent directory is missing or unreadable.`)
  }
  if (!parentStat.isDirectory()) fail(`${label} parent must be a directory.`)
  try {
    writeFileSync(path, canonicalJson(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail(`${label} must be fresh and must not already exist.`)
    }
    fail(`${label} could not be written.`)
  }
}

function parseArguments(argv, allowedKeys, requiredKeys) {
  const values = new Map()
  if (argv.length % 2 !== 0) fail('Unexpected or malformed command-line arguments.')
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (
      typeof option !== 'string' ||
      !option.startsWith('--') ||
      !allowedKeys.has(option.slice(2)) ||
      values.has(option.slice(2)) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      fail('Unexpected or malformed command-line arguments.')
    }
    values.set(option.slice(2), value)
  }
  if (requiredKeys.some((key) => !values.has(key))) {
    fail('A required command-line argument is missing.')
  }
  return values
}

function bindingValue(argumentsMap, key, environmentName, fallback = '') {
  return argumentsMap.get(key) ?? process.env[environmentName] ?? fallback
}

function normalizeExpectedArchitecture(value) {
  if (!value) return undefined
  if (value === 'X64') return 'x64'
  if (value !== 'x64') fail('Expected Node.js architecture must be x64.')
  return value
}

function runCreate(argv) {
  const required = [
    'console-log',
    'log-directory',
    'build-version',
    'editor-version',
    'source-manifest',
    'package-directory',
    'variant',
    'embedded-python-version',
    'cef-product-version',
    'cef-chromium-version',
    'package-artifact-id',
    'package-artifact-name',
    'package-artifact-digest',
    'output',
  ]
  const allowed = new Set([
    ...required,
    'repository',
    'commit',
    'run-id',
    'run-attempt',
    'job-key',
    'job-name',
    'workflow-path',
    'workflow-name',
    'node-architecture',
  ])
  const argumentsMap = parseArguments(argv, allowed, required)
  const document = createBuildEnvironment({
    consoleLogPath: argumentsMap.get('console-log'),
    logDirectoryPath: argumentsMap.get('log-directory'),
    buildVersionPath: argumentsMap.get('build-version'),
    editorVersionPath: argumentsMap.get('editor-version'),
    sourceManifestPath: argumentsMap.get('source-manifest'),
    repository: bindingValue(argumentsMap, 'repository', 'GITHUB_REPOSITORY'),
    sourceCommit: bindingValue(argumentsMap, 'commit', 'GITHUB_SHA').toLowerCase(),
    runId: parseSafePositiveInteger(
      bindingValue(argumentsMap, 'run-id', 'GITHUB_RUN_ID'),
      'Workflow run id',
    ),
    runAttempt: parseSafePositiveInteger(
      bindingValue(argumentsMap, 'run-attempt', 'GITHUB_RUN_ATTEMPT'),
      'Workflow run attempt',
    ),
    jobKey: bindingValue(argumentsMap, 'job-key', 'GITHUB_JOB'),
    jobName: bindingValue(argumentsMap, 'job-name', 'GITHUB_JOB_NAME'),
    workflowPath: argumentsMap.get('workflow-path') ?? EXPECTED_WORKFLOW_PATH,
    workflowName: bindingValue(
      argumentsMap,
      'workflow-name',
      'GITHUB_WORKFLOW',
      EXPECTED_WORKFLOW_NAME,
    ),
    expectedNodeArchitecture: normalizeExpectedArchitecture(
      bindingValue(argumentsMap, 'node-architecture', 'RUNNER_ARCH'),
    ),
    packageArtifactId: parseSafePositiveInteger(
      argumentsMap.get('package-artifact-id'),
      'Package artifact id',
    ),
    packageArtifactName: argumentsMap.get('package-artifact-name'),
    packageArtifactDigest: argumentsMap.get('package-artifact-digest'),
    packageDirectoryPath: argumentsMap.get('package-directory'),
    variantId: argumentsMap.get('variant'),
    embeddedPythonVersion: argumentsMap.get('embedded-python-version'),
    cefProductVersion: argumentsMap.get('cef-product-version'),
    cefChromiumVersion: argumentsMap.get('cef-chromium-version'),
  })
  writeFreshJson(argumentsMap.get('output'), document, 'Build-environment output')
}

function runVerify(argv) {
  const required = [
    'input',
    'repository',
    'commit',
    'run-id',
    'run-attempt',
    'job-key',
    'package-artifact-id',
    'package-artifact-name',
    'package-artifact-digest',
    'variant',
    'canonical-output',
  ]
  const argumentsMap = parseArguments(argv, new Set(required), required)
  const variant = requireReleaseVariant(argumentsMap.get('variant'))
  const expected = {
    releaseVariant: variant.releaseVariant,
    buildId: variant.engine.buildId,
    repository: validateRepository(argumentsMap.get('repository')),
    sourceCommit: validateCommit(argumentsMap.get('commit').toLowerCase()),
    runId: parseSafePositiveInteger(argumentsMap.get('run-id'), 'Workflow run id'),
    runAttempt: parseSafePositiveInteger(
      argumentsMap.get('run-attempt'),
      'Workflow run attempt',
    ),
    jobKey: requireString(argumentsMap.get('job-key'), 'Workflow job key'),
    artifactId: parseSafePositiveInteger(
      argumentsMap.get('package-artifact-id'),
      'Package artifact id',
    ),
    artifactName: argumentsMap.get('package-artifact-name'),
    artifactDigest: argumentsMap.get('package-artifact-digest'),
  }
  if (
    expected.jobKey !== EXPECTED_JOB_KEY ||
    expected.artifactName !== variant.packageArtifactName ||
    !SHA256_PATTERN.test(expected.artifactDigest)
  ) {
    fail('Expected release subject bindings are invalid.')
  }
  const document = validateBuildEnvironment(
    readJson(argumentsMap.get('input'), 'Build-environment input'),
    expected,
  )
  writeFreshJson(
    argumentsMap.get('canonical-output'),
    document,
    'Canonical build-environment output',
  )
}

function runCli() {
  const [command, ...argv] = process.argv.slice(2)
  if (command === 'create') runCreate(argv)
  else if (command === 'verify') runVerify(argv)
  else fail('Usage: ue-build-environment.mjs <create|verify> [options]')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `Build-environment evidence failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
    )
    process.exitCode = 1
  }
}
