#!/usr/bin/env node

import { open, lstat, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { RELEASE_VARIANTS } from './ue-release-variants.mjs'

export const CLEAN_HOST_EVIDENCE_SCHEMA_VERSION = 1
export const CLEAN_HOST_RELEASE_TAG = 'v0.3.0'
export const CLEAN_HOST_PLUGIN_VERSION = 4
export const CLEAN_HOST_PLUGIN_VERSION_NAME = '0.3.0'
export const MAX_GUEST_EVIDENCE_BYTES = 256 * 1024
export const EXPECTED_AUTOMATION_TESTS = Object.freeze([
  'UnrealEditorWebUI.Bridge.PackagedRegistryPing',
  'UnrealEditorWebUI.Bridge.ThirdPartyToolPacks',
])
export const EXPECTED_COMMAND_RESULTS = Object.freeze([
  'system.ping',
  'system.toolPacks',
  'fixture.asset.echo',
  'fixture.level.echo',
])
export const EXPECTED_CONSUMER_BASELINE_FIELDS = Object.freeze([
  'nodeCommandAbsent',
  'npmCommandAbsent',
  'systemPythonRuntimeAbsent',
  'visualStudioInstallationAbsent',
  'msvcCompilerAbsent',
  'windowsSdkDevelopmentFilesAbsent',
])
export const EXPECTED_TOOL_PACKS = Object.freeze([
  Object.freeze({
    id: 'AssetToolsFixture',
    subject: 'AssetToolsFixture-1.0.0-ToolPack.zip',
  }),
  Object.freeze({
    id: 'LevelToolsFixture',
    subject: 'LevelToolsFixture-1.0.0-ToolPack.zip',
  }),
  Object.freeze({
    id: 'ExampleAssetTools',
    subject: 'ExampleAssetTools-1.0.0-ToolPack.zip',
  }),
])

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const OS_VERSION_PATTERN = /^10\.0\.(?<build>[1-9][0-9]{3,5})(?:\.[0-9]+)?$/u
const MAX_JSON_NODES = 4096
const MAX_ARRAY_ITEMS = 32
const MAX_OBJECT_FIELDS = 32
const MAX_STRING_LENGTH = 512
const POSITIVE_CELL_KEYS = Object.freeze([
  'archiveVariantId',
  'outcome',
  'editorLaunched',
  'editorExitCode',
  'compileMarkersDetected',
  'runtimeInstallMarkersDetected',
  'automationTests',
  'commandResults',
  'logSha256',
])
const NEGATIVE_CELL_KEYS = Object.freeze([
  'archiveVariantId',
  'outcome',
  'editorLaunched',
  'rejectionReason',
  'descriptorEngineVersion',
  'moduleBuildId',
])

function fail(message) {
  throw new Error(`Clean-host evidence is invalid: ${message}`)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`)
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} contains an unexpected or missing field.`)
  }
}

function exactArray(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    fail(`${label} must contain the exact closed set.`)
  }
}

function exactString(value, expected, label) {
  if (value !== expected) fail(`${label} does not match the closed contract.`)
  return value
}

function exactInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value !== expected) {
    fail(`${label} does not match the closed contract.`)
  }
  return value
}

function canonicalSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a canonical SHA-256 digest.`)
  }
  return value
}

function assertPrivacySafe(document) {
  const pending = [document]
  let visited = 0

  while (pending.length > 0) {
    const value = pending.pop()
    visited += 1
    if (visited > MAX_JSON_NODES) fail('the JSON document exceeds its structural bound.')

    if (typeof value === 'string') {
      if (
        value.length > MAX_STRING_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|var|etc|opt|mnt|Volumes)\/)/u.test(
          value,
        ) ||
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
        /\b(?:github_pat_|gh[pousr]_|Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/iu.test(value) ||
        /\b(?:password|passwd|secret|credential|access[_-]?token)\s*[:=]/iu.test(value)
      ) {
        fail('the JSON document contains prohibited path, control, log, or secret text.')
      }
      continue
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) fail('the JSON document exceeds its array bound.')
      pending.push(...value)
      continue
    }

    if (isRecord(value)) {
      const entries = Object.entries(value)
      if (entries.length > MAX_OBJECT_FIELDS) {
        fail('the JSON document exceeds its object-field bound.')
      }
      for (const [key, child] of entries) {
        if (
          key.length > 128 ||
          /[\u0000-\u001f\u007f]/u.test(key) ||
          /(?:password|passwd|secret|credential|token|raw.?log|absolute.?path)/iu.test(key)
        ) {
          fail('the JSON document contains a prohibited field name.')
        }
        pending.push(child)
      }
    }
  }
}

function assertNoDuplicateObjectKeys(text) {
  const stack = []

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      let escaped = false
      for (; index < text.length; index += 1) {
        const current = text[index]
        if (escaped) {
          escaped = false
        } else if (current === '\\') {
          escaped = true
        } else if (current === '"') {
          break
        }
      }
      if (index >= text.length) fail('the JSON document cannot be decoded.')

      let next = index + 1
      while (next < text.length && /\s/u.test(text[next])) next += 1
      const currentContainer = stack.at(-1)
      if (text[next] === ':' && currentContainer?.type === 'object') {
        let key
        try {
          key = JSON.parse(text.slice(start, index + 1))
        } catch {
          fail('the JSON document cannot be decoded.')
        }
        if (currentContainer.keys.has(key)) {
          fail('the JSON document contains duplicate object fields.')
        }
        currentContainer.keys.add(key)
      }
      continue
    }
    if (character === '{') stack.push({ keys: new Set(), type: 'object' })
    else if (character === '[') stack.push({ type: 'array' })
    else if (character === '}' || character === ']') stack.pop()
  }
}

function parseStrictJson(text) {
  assertNoDuplicateObjectKeys(text)
  let document
  try {
    document = JSON.parse(text)
  } catch {
    fail('the JSON document cannot be decoded.')
  }
  assertPrivacySafe(document)
  return document
}

function canonicalRelease(value) {
  exactKeys(value, ['tag', 'commit', 'sourceKind'], 'release')
  exactString(value.tag, CLEAN_HOST_RELEASE_TAG, 'release.tag')
  if (typeof value.commit !== 'string' || !COMMIT_PATTERN.test(value.commit)) {
    fail('release.commit must be one lowercase 40-character commit SHA.')
  }
  if (value.sourceKind !== 'candidate' && value.sourceKind !== 'published') {
    fail('release.sourceKind must identify candidate or published inputs.')
  }
  return {
    tag: CLEAN_HOST_RELEASE_TAG,
    commit: value.commit,
    sourceKind: value.sourceKind,
  }
}

function canonicalOperatingSystem(value) {
  exactKeys(
    value,
    ['platform', 'version', 'buildNumber', 'architecture', 'windowsSandbox'],
    'guest.os',
  )
  exactString(value.platform, 'win32', 'guest.os.platform')
  exactString(value.architecture, 'x64', 'guest.os.architecture')
  if (value.windowsSandbox !== true) {
    fail('guest.os.windowsSandbox must be true.')
  }
  if (typeof value.version !== 'string') fail('guest.os.version is invalid.')
  const versionMatch = OS_VERSION_PATTERN.exec(value.version)
  if (
    !versionMatch ||
    !Number.isSafeInteger(value.buildNumber) ||
    Number(versionMatch.groups.build) !== value.buildNumber
  ) {
    fail('guest.os version and buildNumber are invalid or inconsistent.')
  }
  return {
    platform: 'win32',
    version: value.version,
    buildNumber: value.buildNumber,
    architecture: 'x64',
    windowsSandbox: true,
  }
}

function canonicalConsumerBaseline(value) {
  exactKeys(value, EXPECTED_CONSUMER_BASELINE_FIELDS, 'guest.consumerBaseline')
  const result = {}
  for (const name of EXPECTED_CONSUMER_BASELINE_FIELDS) {
    if (value[name] !== true) {
      fail('guest.consumerBaseline must prove every closed consumer fact.')
    }
    result[name] = true
  }
  return result
}

function canonicalEngine(value) {
  exactKeys(
    value,
    [
      'variantId',
      'majorVersion',
      'minorVersion',
      'patchVersion',
      'changelist',
      'compatibleChangelist',
      'branchName',
      'buildId',
    ],
    'guest.engine',
  )
  const expected = RELEASE_VARIANTS.find((variant) => variant.id === value.variantId)
  if (!expected) fail('guest.engine.variantId is outside the closed variant set.')
  for (const key of [
    'majorVersion',
    'minorVersion',
    'patchVersion',
    'changelist',
    'compatibleChangelist',
  ]) {
    exactInteger(value[key], expected.engine[key], `guest.engine.${key}`)
  }
  exactString(value.branchName, expected.engine.branchName, 'guest.engine.branchName')
  exactString(value.buildId, expected.engine.buildId, 'guest.engine.buildId')
  return {
    variantId: expected.id,
    majorVersion: expected.engine.majorVersion,
    minorVersion: expected.engine.minorVersion,
    patchVersion: expected.engine.patchVersion,
    changelist: expected.engine.changelist,
    compatibleChangelist: expected.engine.compatibleChangelist,
    branchName: expected.engine.branchName,
    buildId: expected.engine.buildId,
  }
}

function canonicalGuest(value) {
  exactKeys(value, ['os', 'consumerBaseline', 'engine'], 'guest')
  return {
    os: canonicalOperatingSystem(value.os),
    consumerBaseline: canonicalConsumerBaseline(value.consumerBaseline),
    engine: canonicalEngine(value.engine),
  }
}

function canonicalCoreArchives(value) {
  exactArray(value, RELEASE_VARIANTS.length, 'inputs.coreArchives')
  const result = value.map((archive, index) => {
    const expected = RELEASE_VARIANTS[index]
    exactKeys(
      archive,
      [
        'variantId',
        'subject',
        'sha256',
        'descriptorVersion',
        'descriptorVersionName',
        'descriptorEngineVersion',
        'moduleBuildId',
      ],
      `inputs.coreArchives[${index}]`,
    )
    exactString(archive.variantId, expected.id, `inputs.coreArchives[${index}].variantId`)
    exactString(
      archive.subject,
      `UnrealEditorWebUI-${CLEAN_HOST_RELEASE_TAG}-${expected.releaseVariant}.zip`,
      `inputs.coreArchives[${index}].subject`,
    )
    exactInteger(
      archive.descriptorVersion,
      CLEAN_HOST_PLUGIN_VERSION,
      `inputs.coreArchives[${index}].descriptorVersion`,
    )
    exactString(
      archive.descriptorVersionName,
      CLEAN_HOST_PLUGIN_VERSION_NAME,
      `inputs.coreArchives[${index}].descriptorVersionName`,
    )
    exactString(
      archive.descriptorEngineVersion,
      `${expected.engineAssociation}.0`,
      `inputs.coreArchives[${index}].descriptorEngineVersion`,
    )
    exactString(
      archive.moduleBuildId,
      expected.engine.buildId,
      `inputs.coreArchives[${index}].moduleBuildId`,
    )
    return {
      variantId: expected.id,
      subject: archive.subject,
      sha256: canonicalSha256(archive.sha256, `inputs.coreArchives[${index}].sha256`),
      descriptorVersion: CLEAN_HOST_PLUGIN_VERSION,
      descriptorVersionName: CLEAN_HOST_PLUGIN_VERSION_NAME,
      descriptorEngineVersion: archive.descriptorEngineVersion,
      moduleBuildId: archive.moduleBuildId,
    }
  })
  return result
}

function canonicalToolPacks(value) {
  exactArray(value, EXPECTED_TOOL_PACKS.length, 'inputs.toolPacks')
  return value.map((toolPack, index) => {
    const expected = EXPECTED_TOOL_PACKS[index]
    exactKeys(toolPack, ['id', 'subject', 'sha256'], `inputs.toolPacks[${index}]`)
    exactString(toolPack.id, expected.id, `inputs.toolPacks[${index}].id`)
    exactString(toolPack.subject, expected.subject, `inputs.toolPacks[${index}].subject`)
    return {
      id: expected.id,
      subject: expected.subject,
      sha256: canonicalSha256(toolPack.sha256, `inputs.toolPacks[${index}].sha256`),
    }
  })
}

function canonicalInputs(value) {
  exactKeys(value, ['coreArchives', 'toolPacks'], 'inputs')
  const coreArchives = canonicalCoreArchives(value.coreArchives)
  const toolPacks = canonicalToolPacks(value.toolPacks)
  const subjects = [...coreArchives, ...toolPacks].map((archive) => archive.subject)
  const hashes = [...coreArchives, ...toolPacks].map((archive) => archive.sha256)
  if (new Set(subjects).size !== subjects.length) {
    fail('input archive subjects must be unique.')
  }
  if (new Set(hashes).size !== hashes.length) {
    fail('input archive SHA-256 digests must be unique.')
  }
  return { coreArchives, toolPacks }
}

function canonicalSuccessResults(value, expectedNames, label) {
  exactKeys(value, expectedNames, label)
  const result = {}
  for (const name of expectedNames) {
    exactString(value[name], 'success', `${label} result`)
    result[name] = 'success'
  }
  return result
}

function canonicalMismatch(value, engineValue, archiveValue, label) {
  exactKeys(value, ['engineValue', 'archiveValue'], label)
  exactString(value.engineValue, engineValue, `${label}.engineValue`)
  exactString(value.archiveValue, archiveValue, `${label}.archiveValue`)
  if (value.engineValue === value.archiveValue) fail(`${label} must prove an exact mismatch.`)
  return { engineValue, archiveValue }
}

function canonicalMatrix(value, engine, inputs) {
  exactArray(value, RELEASE_VARIANTS.length, 'matrix')
  const engineVariant = RELEASE_VARIANTS.find((variant) => variant.id === engine.variantId)

  return value.map((cell, index) => {
    const archiveVariant = RELEASE_VARIANTS[index]
    const archive = inputs.coreArchives[index]
    const isDiagonal = engine.variantId === archiveVariant.id

    if (isDiagonal) {
      exactKeys(cell, POSITIVE_CELL_KEYS, `matrix[${index}]`)
      exactString(cell.archiveVariantId, archiveVariant.id, `matrix[${index}].archiveVariantId`)
      exactString(cell.outcome, 'success', `matrix[${index}].outcome`)
      if (
        cell.editorLaunched !== true ||
        cell.editorExitCode !== 0 ||
        cell.compileMarkersDetected !== false ||
        cell.runtimeInstallMarkersDetected !== false
      ) {
        fail('the matching matrix cell does not prove a clean successful editor run.')
      }
      return {
        archiveVariantId: archiveVariant.id,
        outcome: 'success',
        editorLaunched: true,
        editorExitCode: 0,
        compileMarkersDetected: false,
        runtimeInstallMarkersDetected: false,
        automationTests: canonicalSuccessResults(
          cell.automationTests,
          EXPECTED_AUTOMATION_TESTS,
          `matrix[${index}].automationTests`,
        ),
        commandResults: canonicalSuccessResults(
          cell.commandResults,
          EXPECTED_COMMAND_RESULTS,
          `matrix[${index}].commandResults`,
        ),
        logSha256: canonicalSha256(cell.logSha256, `matrix[${index}].logSha256`),
      }
    }

    exactKeys(cell, NEGATIVE_CELL_KEYS, `matrix[${index}]`)
    exactString(cell.archiveVariantId, archiveVariant.id, `matrix[${index}].archiveVariantId`)
    exactString(cell.outcome, 'prelaunch-rejected', `matrix[${index}].outcome`)
    exactString(
      cell.rejectionReason,
      'descriptor-and-build-id-mismatch',
      `matrix[${index}].rejectionReason`,
    )
    if (cell.editorLaunched !== false) {
      fail('the off-diagonal matrix cell must prove no editor was launched.')
    }
    return {
      archiveVariantId: archiveVariant.id,
      outcome: 'prelaunch-rejected',
      editorLaunched: false,
      rejectionReason: 'descriptor-and-build-id-mismatch',
      descriptorEngineVersion: canonicalMismatch(
        cell.descriptorEngineVersion,
        `${engineVariant.engineAssociation}.0`,
        archive.descriptorEngineVersion,
        `matrix[${index}].descriptorEngineVersion`,
      ),
      moduleBuildId: canonicalMismatch(
        cell.moduleBuildId,
        engineVariant.engine.buildId,
        archive.moduleBuildId,
        `matrix[${index}].moduleBuildId`,
      ),
    }
  })
}

export function validateGuestEvidence(document, expectedVariantId = undefined) {
  assertPrivacySafe(document)
  exactKeys(
    document,
    ['schemaVersion', 'result', 'release', 'guest', 'inputs', 'matrix'],
    'evidence',
  )
  exactInteger(
    document.schemaVersion,
    CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
    'evidence.schemaVersion',
  )
  exactString(document.result, 'success', 'evidence.result')
  const release = canonicalRelease(document.release)
  const guest = canonicalGuest(document.guest)
  if (expectedVariantId !== undefined && guest.engine.variantId !== expectedVariantId) {
    fail('the guest file does not match its required engine variant.')
  }
  const inputs = canonicalInputs(document.inputs)
  const matrix = canonicalMatrix(document.matrix, guest.engine, inputs)
  return {
    schemaVersion: CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
    result: 'success',
    release,
    guest,
    inputs,
    matrix,
  }
}

export function aggregateCleanHostEvidence(documents) {
  exactArray(documents, RELEASE_VARIANTS.length, 'guest evidence inputs')
  const validated = documents.map((document) => validateGuestEvidence(document))
  const byVariant = new Map()
  for (const document of validated) {
    const variantId = document.guest.engine.variantId
    if (byVariant.has(variantId)) fail('guest evidence variants must be unique.')
    byVariant.set(variantId, document)
  }
  const ordered = RELEASE_VARIANTS.map((variant) => byVariant.get(variant.id))
  if (ordered.some((document) => document === undefined)) {
    fail('guest evidence must cover the exact closed engine set.')
  }

  const releaseJson = JSON.stringify(ordered[0].release)
  const inputsJson = JSON.stringify(ordered[0].inputs)
  if (
    ordered.some(
      (document) =>
        JSON.stringify(document.release) !== releaseJson ||
        JSON.stringify(document.inputs) !== inputsJson,
    )
  ) {
    fail('guest evidence release and input bindings must agree exactly.')
  }

  const matrix = ordered.flatMap((document) =>
    document.matrix.map((cell) => ({
      engineVariantId: document.guest.engine.variantId,
      ...cell,
    })),
  )
  if (
    matrix.length !== RELEASE_VARIANTS.length ** 2 ||
    matrix.filter((cell) => cell.outcome === 'success').length !== RELEASE_VARIANTS.length ||
    matrix.filter((cell) => cell.outcome === 'prelaunch-rejected').length !== 6
  ) {
    fail('the aggregate matrix must contain exactly three successes and six rejections.')
  }

  return {
    schemaVersion: CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
    result: 'success',
    release: ordered[0].release,
    inputs: ordered[0].inputs,
    guests: ordered.map((document) => document.guest),
    matrix,
  }
}

function normalizedPath(value) {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function assertNoSymlinkAncestors(path, unavailableMessage) {
  let current = resolve(path)
  while (true) {
    let currentStat
    try {
      currentStat = await lstat(current, { bigint: true })
    } catch {
      fail(unavailableMessage)
    }
    if (currentStat.isSymbolicLink()) {
      fail('evidence paths must not traverse reparse indirection.')
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function assertCanonicalExistingFile(path) {
  await assertNoSymlinkAncestors(path, 'an input evidence file is unavailable.')
  let pathStat
  try {
    pathStat = await lstat(path, { bigint: true })
  } catch {
    fail('an input evidence file is unavailable.')
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    fail('input evidence paths must be regular files without reparse indirection.')
  }
  return pathStat
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export async function readGuestEvidenceFile(path) {
  const absolutePath = resolve(path)
  const pathStat = await assertCanonicalExistingFile(absolutePath)
  if (pathStat.size <= 0n || pathStat.size > BigInt(MAX_GUEST_EVIDENCE_BYTES)) {
    fail('an input evidence file is empty or exceeds the byte bound.')
  }

  let handle
  try {
    handle = await open(absolutePath, 'r')
    const openStat = await handle.stat({ bigint: true })
    if (!openStat.isFile() || !sameFileSnapshot(pathStat, openStat)) {
      fail('an input evidence file changed while it was opened.')
    }
    const buffer = Buffer.alloc(MAX_GUEST_EVIDENCE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const finalStat = await handle.stat({ bigint: true })
    if (
      bytesRead > MAX_GUEST_EVIDENCE_BYTES ||
      BigInt(bytesRead) !== openStat.size ||
      !sameFileSnapshot(openStat, finalStat)
    ) {
      fail('an input evidence file changed or exceeds the byte bound.')
    }

    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      fail('an input evidence file is not valid UTF-8.')
    }
    return parseStrictJson(text)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Clean-host evidence is invalid:')) {
      throw error
    }
    fail('an input evidence file could not be read safely.')
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function assertCanonicalOutputParent(outputPath) {
  const parent = dirname(outputPath)
  await assertNoSymlinkAncestors(parent, 'the output parent directory is unavailable.')
  let parentStat
  try {
    parentStat = await lstat(parent)
  } catch {
    fail('the output parent directory is unavailable.')
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail('the output parent must be a real directory without reparse indirection.')
  }
}

async function writeAggregateNoOverwrite(outputPath, aggregate) {
  const absolutePath = resolve(outputPath)
  await assertCanonicalOutputParent(absolutePath)
  const payload = `${JSON.stringify(aggregate, null, 2)}\n`
  let handle
  let created = false
  try {
    handle = await open(absolutePath, 'wx', 0o600)
    created = true
    await handle.writeFile(payload, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    if (created) {
      await handle?.close().catch(() => {})
      handle = undefined
      await rm(absolutePath, { force: true }).catch(() => {})
    }
    if (error?.code === 'EEXIST') {
      fail('the aggregate output must be fresh and must not already exist.')
    }
    if (error instanceof Error && error.message.startsWith('Clean-host evidence is invalid:')) {
      throw error
    }
    fail('the aggregate output could not be written safely.')
  } finally {
    await handle?.close().catch(() => {})
  }
}

function parseCliArguments(argv) {
  const allowed = new Set(['ue54', 'ue55', 'ue58', 'output'])
  const values = new Map()
  if (argv.length !== allowed.size * 2) fail('CLI arguments do not match the closed contract.')
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (
      typeof option !== 'string' ||
      !option.startsWith('--') ||
      !allowed.has(option.slice(2)) ||
      values.has(option.slice(2)) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      fail('CLI arguments do not match the closed contract.')
    }
    values.set(option.slice(2), value)
  }
  if ([...allowed].some((name) => !values.has(name))) {
    fail('CLI arguments do not match the closed contract.')
  }
  return Object.fromEntries(values)
}

export async function runCli(argv) {
  const args = parseCliArguments(argv)
  const inputPaths = RELEASE_VARIANTS.map((variant) => resolve(args[variant.id]))
  const outputPath = resolve(args.output)
  const allPaths = [...inputPaths, outputPath].map(normalizedPath)
  if (new Set(allPaths).size !== allPaths.length) {
    fail('input and output paths must be distinct.')
  }

  const documents = await Promise.all(inputPaths.map((path) => readGuestEvidenceFile(path)))
  for (let index = 0; index < RELEASE_VARIANTS.length; index += 1) {
    validateGuestEvidence(documents[index], RELEASE_VARIANTS[index].id)
  }
  const aggregate = aggregateCleanHostEvidence(documents)
  await writeAggregateNoOverwrite(outputPath, aggregate)
  return aggregate
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof Error && error.message.startsWith('Clean-host evidence is invalid:')
        ? error.message
        : 'Clean-host evidence validation failed safely.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
