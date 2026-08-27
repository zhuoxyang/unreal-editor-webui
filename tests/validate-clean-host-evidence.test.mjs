import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
  CLEAN_HOST_PLUGIN_VERSION,
  CLEAN_HOST_PLUGIN_VERSION_NAME,
  CLEAN_HOST_RELEASE_TAG,
  EXPECTED_CONSUMER_BASELINE_FIELDS,
  EXPECTED_AUTOMATION_TESTS,
  EXPECTED_COMMAND_RESULTS,
  EXPECTED_TOOL_PACKS,
  MAX_GUEST_EVIDENCE_BYTES,
  aggregateCleanHostEvidence,
  readGuestEvidenceFile,
  runCli,
  validateGuestEvidence,
} from '../scripts/validate-clean-host-evidence.mjs'
import { RELEASE_VARIANTS } from '../scripts/ue-release-variants.mjs'

const SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/validate-clean-host-evidence.mjs', import.meta.url),
)
const COMMIT = '1'.repeat(40)

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

function successMap(names) {
  return Object.fromEntries(names.map((name) => [name, 'success']))
}

function coreArchives() {
  return RELEASE_VARIANTS.map((variant, index) => ({
    variantId: variant.id,
    subject: `UnrealEditorWebUI-${CLEAN_HOST_RELEASE_TAG}-${variant.releaseVariant}.zip`,
    sha256: digest(String.fromCharCode(97 + index)),
    descriptorVersion: CLEAN_HOST_PLUGIN_VERSION,
    descriptorVersionName: CLEAN_HOST_PLUGIN_VERSION_NAME,
    descriptorEngineVersion: `${variant.engineAssociation}.0`,
    moduleBuildId: variant.engine.buildId,
  }))
}

function toolPacks() {
  return EXPECTED_TOOL_PACKS.map((toolPack, index) => ({
    ...toolPack,
    sha256: digest(String.fromCharCode(100 + index)),
  }))
}

function makeGuest(variantId, sourceKind = 'candidate') {
  const engineIndex = RELEASE_VARIANTS.findIndex((variant) => variant.id === variantId)
  const variant = RELEASE_VARIANTS[engineIndex]
  const archives = coreArchives()
  return {
    schemaVersion: CLEAN_HOST_EVIDENCE_SCHEMA_VERSION,
    result: 'success',
    release: {
      tag: CLEAN_HOST_RELEASE_TAG,
      commit: COMMIT,
      sourceKind,
    },
    guest: {
      os: {
        platform: 'win32',
        version: '10.0.26100.0',
        buildNumber: 26100,
        architecture: 'x64',
        windowsSandbox: true,
      },
      consumerBaseline: Object.fromEntries(
        EXPECTED_CONSUMER_BASELINE_FIELDS.map((name) => [name, true]),
      ),
      engine: {
        variantId: variant.id,
        majorVersion: variant.engine.majorVersion,
        minorVersion: variant.engine.minorVersion,
        patchVersion: variant.engine.patchVersion,
        changelist: variant.engine.changelist,
        compatibleChangelist: variant.engine.compatibleChangelist,
        branchName: variant.engine.branchName,
        buildId: variant.engine.buildId,
      },
    },
    inputs: {
      coreArchives: archives,
      toolPacks: toolPacks(),
    },
    matrix: RELEASE_VARIANTS.map((archiveVariant, archiveIndex) => {
      if (archiveVariant.id === variant.id) {
        return {
          archiveVariantId: archiveVariant.id,
          outcome: 'success',
          editorLaunched: true,
          editorExitCode: 0,
          compileMarkersDetected: false,
          runtimeInstallMarkersDetected: false,
          automationTests: successMap(EXPECTED_AUTOMATION_TESTS),
          commandResults: successMap(EXPECTED_COMMAND_RESULTS),
          logSha256: digest(String(engineIndex + 1)),
        }
      }
      return {
        archiveVariantId: archiveVariant.id,
        outcome: 'prelaunch-rejected',
        editorLaunched: false,
        rejectionReason: 'descriptor-and-build-id-mismatch',
        descriptorEngineVersion: {
          engineValue: `${variant.engineAssociation}.0`,
          archiveValue: archives[archiveIndex].descriptorEngineVersion,
        },
        moduleBuildId: {
          engineValue: variant.engine.buildId,
          archiveValue: archives[archiveIndex].moduleBuildId,
        },
      }
    }),
  }
}

function allGuests(sourceKind = 'candidate') {
  return RELEASE_VARIANTS.map((variant) => makeGuest(variant.id, sourceKind))
}

function clone(value) {
  return structuredClone(value)
}

test('exports the exact closed test, command, tool, and Tool Pack ordering', () => {
  assert.deepEqual(EXPECTED_AUTOMATION_TESTS, [
    'UnrealEditorWebUI.Bridge.PackagedRegistryPing',
    'UnrealEditorWebUI.Bridge.ThirdPartyToolPacks',
  ])
  assert.deepEqual(EXPECTED_COMMAND_RESULTS, [
    'system.ping',
    'system.toolPacks',
    'fixture.asset.echo',
    'fixture.level.echo',
  ])
  assert.deepEqual(EXPECTED_CONSUMER_BASELINE_FIELDS, [
    'nodeCommandAbsent',
    'npmCommandAbsent',
    'systemPythonRuntimeAbsent',
    'visualStudioInstallationAbsent',
    'msvcCompilerAbsent',
    'windowsSdkDevelopmentFilesAbsent',
  ])
  assert.deepEqual(
    EXPECTED_TOOL_PACKS.map(({ id }) => id),
    ['AssetToolsFixture', 'LevelToolsFixture', 'ExampleAssetTools'],
  )
})

test('accepts and canonicalizes one exact engine row', () => {
  const validated = validateGuestEvidence(makeGuest('ue55'), 'ue55')
  assert.equal(validated.release.sourceKind, 'candidate')
  assert.equal(validated.guest.engine.patchVersion, 4)
  assert.deepEqual(
    validated.matrix.map(({ archiveVariantId, outcome }) => [archiveVariantId, outcome]),
    [
      ['ue54', 'prelaunch-rejected'],
      ['ue55', 'success'],
      ['ue58', 'prelaunch-rejected'],
    ],
  )
  assert.deepEqual(Object.keys(validated.matrix[1].automationTests), EXPECTED_AUTOMATION_TESTS)
  assert.deepEqual(Object.keys(validated.matrix[1].commandResults), EXPECTED_COMMAND_RESULTS)
})

test('aggregates shuffled rows into one canonical closed 3x3 matrix', () => {
  const guests = allGuests()
  const aggregate = aggregateCleanHostEvidence([guests[2], guests[0], guests[1]])
  assert.equal(aggregate.schemaVersion, 1)
  assert.equal(aggregate.result, 'success')
  assert.deepEqual(
    aggregate.guests.map(({ engine }) => engine.variantId),
    ['ue54', 'ue55', 'ue58'],
  )
  assert.deepEqual(
    aggregate.matrix.map(({ engineVariantId, archiveVariantId }) =>
      `${engineVariantId}/${archiveVariantId}`,
    ),
    [
      'ue54/ue54',
      'ue54/ue55',
      'ue54/ue58',
      'ue55/ue54',
      'ue55/ue55',
      'ue55/ue58',
      'ue58/ue54',
      'ue58/ue55',
      'ue58/ue58',
    ],
  )
  assert.equal(aggregate.matrix.filter(({ outcome }) => outcome === 'success').length, 3)
  assert.equal(
    aggregate.matrix.filter(({ outcome }) => outcome === 'prelaunch-rejected').length,
    6,
  )
  assert.equal(
    JSON.stringify(aggregate).includes('C:\\') || JSON.stringify(aggregate).includes('/home/'),
    false,
  )
})

test('preserves the published replay source kind', () => {
  const aggregate = aggregateCleanHostEvidence(allGuests('published'))
  assert.equal(aggregate.release.sourceKind, 'published')
})

const fragmentRejections = [
  ['unknown top-level field', (value) => { value.extra = true }, /unexpected or missing field/u],
  ['wrong schema', (value) => { value.schemaVersion = 2 }, /schemaVersion/u],
  ['non-success result', (value) => { value.result = 'partial' }, /result/u],
  ['wrong release tag', (value) => { value.release.tag = 'v0.3.1' }, /release\.tag/u],
  ['short commit', (value) => { value.release.commit = '1'.repeat(39) }, /40-character/u],
  ['uppercase commit', (value) => { value.release.commit = 'A'.repeat(40) }, /40-character/u],
  ['unknown source kind', (value) => { value.release.sourceKind = 'local' }, /sourceKind/u],
  ['non-Sandbox claim', (value) => { value.guest.os.windowsSandbox = false }, /windowsSandbox/u],
  ['wrong platform', (value) => { value.guest.os.platform = 'linux' }, /platform/u],
  ['wrong architecture', (value) => { value.guest.os.architecture = 'arm64' }, /architecture/u],
  ['malformed OS version', (value) => { value.guest.os.version = '6.1.7601' }, /version/u],
  ['inconsistent OS build', (value) => { value.guest.os.buildNumber = 22631 }, /inconsistent/u],
  ['present Node', (value) => { value.guest.consumerBaseline.nodeCommandAbsent = false }, /every closed consumer fact/u],
  ['missing baseline claim', (value) => { delete value.guest.consumerBaseline.msvcCompilerAbsent }, /unexpected or missing/u],
  ['unknown baseline claim', (value) => { value.guest.consumerBaseline.gitAbsent = true }, /unexpected or missing/u],
  ['wrong engine patch', (value) => { value.guest.engine.patchVersion += 1 }, /patchVersion/u],
  ['wrong engine branch', (value) => { value.guest.engine.branchName = '++UE5+Release-5.6' }, /branchName/u],
  ['unknown engine variant', (value) => { value.guest.engine.variantId = 'ue56' }, /variantId/u],
  ['missing core archive', (value) => { value.inputs.coreArchives.pop() }, /exact closed set/u],
  ['reordered core archives', (value) => { value.inputs.coreArchives.reverse() }, /variantId/u],
  ['wrong core subject', (value) => { value.inputs.coreArchives[0].subject = 'other.zip' }, /subject/u],
  ['unprefixed core hash', (value) => { value.inputs.coreArchives[0].sha256 = 'a'.repeat(64) }, /canonical SHA-256/u],
  ['uppercase core hash', (value) => { value.inputs.coreArchives[0].sha256 = digest('A') }, /canonical SHA-256/u],
  ['wrong descriptor version', (value) => { value.inputs.coreArchives[0].descriptorVersion = 3 }, /descriptorVersion/u],
  ['wrong descriptor name', (value) => { value.inputs.coreArchives[0].descriptorVersionName = '0.2.0' }, /descriptorVersionName/u],
  ['wrong descriptor engine', (value) => { value.inputs.coreArchives[0].descriptorEngineVersion = '5.5.0' }, /descriptorEngineVersion/u],
  ['wrong module BuildId', (value) => { value.inputs.coreArchives[0].moduleBuildId = '1' }, /moduleBuildId/u],
  ['duplicate archive hash', (value) => { value.inputs.toolPacks[0].sha256 = value.inputs.coreArchives[0].sha256 }, /digests must be unique/u],
  ['missing Tool Pack', (value) => { value.inputs.toolPacks.pop() }, /exact closed set/u],
  ['reordered Tool Packs', (value) => { value.inputs.toolPacks.reverse() }, /inputs\.toolPacks\[0\]\.id/u],
  ['wrong Tool Pack subject', (value) => { value.inputs.toolPacks[0].subject = 'pack.zip' }, /subject/u],
  ['partial matrix', (value) => { value.matrix.pop() }, /exact closed set/u],
  ['reordered matrix', (value) => { value.matrix.reverse() }, /unexpected or missing|archiveVariantId/u],
  ['diagonal rejection', (value) => { value.matrix[0].outcome = 'prelaunch-rejected' }, /outcome/u],
  ['diagonal editor not launched', (value) => { value.matrix[0].editorLaunched = false }, /clean successful/u],
  ['diagonal nonzero exit', (value) => { value.matrix[0].editorExitCode = 1 }, /clean successful/u],
  ['diagonal compile marker', (value) => { value.matrix[0].compileMarkersDetected = true }, /clean successful/u],
  ['diagonal install marker', (value) => { value.matrix[0].runtimeInstallMarkersDetected = true }, /clean successful/u],
  ['missing automation test', (value) => { delete value.matrix[0].automationTests[EXPECTED_AUTOMATION_TESTS[0]] }, /unexpected or missing/u],
  ['failed automation test', (value) => { value.matrix[0].automationTests[EXPECTED_AUTOMATION_TESTS[0]] = 'failure' }, /result/u],
  ['missing command claim', (value) => { delete value.matrix[0].commandResults['system.toolPacks'] }, /unexpected or missing/u],
  ['failed command claim', (value) => { value.matrix[0].commandResults['fixture.level.echo'] = 'failure' }, /result/u],
  ['invalid log hash', (value) => { value.matrix[0].logSha256 = 'sha256:bad' }, /canonical SHA-256/u],
  ['negative launch', (value) => { value.matrix[1].editorLaunched = true }, /no editor/u],
  ['wrong negative outcome', (value) => { value.matrix[1].outcome = 'failure' }, /outcome/u],
  ['wrong rejection reason', (value) => { value.matrix[1].rejectionReason = 'unknown' }, /rejectionReason/u],
  ['missing descriptor mismatch', (value) => { delete value.matrix[1].descriptorEngineVersion.archiveValue }, /unexpected or missing/u],
  ['wrong descriptor mismatch value', (value) => { value.matrix[1].descriptorEngineVersion.archiveValue = '5.8.0' }, /archiveValue/u],
  ['wrong BuildId mismatch value', (value) => { value.matrix[1].moduleBuildId.archiveValue = '123' }, /archiveValue/u],
  ['raw log field', (value) => { value.matrix[0].rawLog = 'LogInit: hello' }, /prohibited field name/u],
]

for (const [name, mutate, expected] of fragmentRejections) {
  test(`rejects ${name}`, () => {
    const value = makeGuest('ue54')
    mutate(value)
    assert.throws(() => validateGuestEvidence(value), expected)
  })
}

test('rejects absolute paths and secrets without echoing attacker-controlled strings', () => {
  const absolutePath = makeGuest('ue54')
  const privatePath = 'C:\\Users\\PrivatePerson\\raw.log'
  absolutePath.guest.os.version = privatePath
  assert.throws(
    () => validateGuestEvidence(absolutePath),
    (error) =>
      /prohibited path/u.test(error.message) &&
      !error.message.includes(privatePath) &&
      !error.message.includes('PrivatePerson'),
  )

  const secret = makeGuest('ue54')
  const attackerSecret = `github_pat_${'A'.repeat(30)}`
  secret.release.commit = attackerSecret
  assert.throws(
    () => validateGuestEvidence(secret),
    (error) =>
      /prohibited path, control, log, or secret text/u.test(error.message) &&
      !error.message.includes(attackerSecret),
  )
})

test('rejects duplicate, missing, and disagreeing guest rows', () => {
  assert.throws(
    () => aggregateCleanHostEvidence([makeGuest('ue54'), makeGuest('ue54'), makeGuest('ue58')]),
    /variants must be unique/u,
  )
  assert.throws(
    () => aggregateCleanHostEvidence([makeGuest('ue54'), makeGuest('ue55')]),
    /exact closed set/u,
  )

  const sourceMismatch = allGuests()
  sourceMismatch[2].release.sourceKind = 'published'
  assert.throws(() => aggregateCleanHostEvidence(sourceMismatch), /bindings must agree/u)

  const hashMismatch = allGuests()
  hashMismatch[1].inputs.coreArchives[0].sha256 = digest('9')
  assert.throws(() => aggregateCleanHostEvidence(hashMismatch), /bindings must agree/u)
})

async function writeGuestFiles(directory, sourceKind = 'candidate') {
  const result = {}
  for (const variant of RELEASE_VARIANTS) {
    const path = join(directory, `${variant.id}.json`)
    await writeFile(path, `${JSON.stringify(makeGuest(variant.id, sourceKind), null, 2)}\n`, 'utf8')
    result[variant.id] = path
  }
  return result
}

test('CLI validates three files and creates one fresh canonical aggregate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ue-webui-clean-evidence-'))
  const inputs = await writeGuestFiles(directory)
  const output = join(directory, 'aggregate.json')
  const aggregate = await runCli([
    '--ue54', inputs.ue54,
    '--ue55', inputs.ue55,
    '--ue58', inputs.ue58,
    '--output', output,
  ])
  const written = JSON.parse(await readFile(output, 'utf8'))
  assert.deepEqual(written, aggregate)
  assert.equal(written.matrix.length, 9)

  await assert.rejects(
    runCli([
      '--ue54', inputs.ue54,
      '--ue55', inputs.ue55,
      '--ue58', inputs.ue58,
      '--output', output,
    ]),
    /must be fresh/u,
  )
})

test('executable CLI entry point emits the same canonical aggregate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ue-webui-clean-cli-'))
  const inputs = await writeGuestFiles(directory, 'published')
  const output = join(directory, 'published-aggregate.json')
  execFileSync(process.execPath, [
    SCRIPT_PATH,
    '--ue58', inputs.ue58,
    '--output', output,
    '--ue54', inputs.ue54,
    '--ue55', inputs.ue55,
  ], { stdio: 'pipe' })
  const aggregate = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(aggregate.release.sourceKind, 'published')
  assert.deepEqual(
    aggregate.guests.map(({ engine }) => engine.variantId),
    ['ue54', 'ue55', 'ue58'],
  )
})

test('CLI rejects swapped named rows and reused input/output paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ue-webui-clean-paths-'))
  const inputs = await writeGuestFiles(directory)
  await assert.rejects(
    runCli([
      '--ue54', inputs.ue55,
      '--ue55', inputs.ue54,
      '--ue58', inputs.ue58,
      '--output', join(directory, 'swapped.json'),
    ]),
    /required engine variant/u,
  )
  await assert.rejects(
    runCli([
      '--ue54', inputs.ue54,
      '--ue55', inputs.ue55,
      '--ue58', inputs.ue58,
      '--output', inputs.ue54,
    ]),
    /must be distinct/u,
  )
})

test('file reader rejects malformed, duplicate-key, oversized, and empty JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ue-webui-clean-json-'))
  const malformed = join(directory, 'malformed.json')
  await writeFile(malformed, '{', 'utf8')
  await assert.rejects(readGuestEvidenceFile(malformed), /cannot be decoded/u)

  const duplicate = join(directory, 'duplicate.json')
  const validText = JSON.stringify(makeGuest('ue54'))
  await writeFile(
    duplicate,
    validText.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1'),
    'utf8',
  )
  await assert.rejects(readGuestEvidenceFile(duplicate), /duplicate object fields/u)

  const oversized = join(directory, 'oversized.json')
  await writeFile(oversized, Buffer.alloc(MAX_GUEST_EVIDENCE_BYTES + 1, 0x20))
  await assert.rejects(readGuestEvidenceFile(oversized), /exceeds the byte bound/u)

  const empty = join(directory, 'empty.json')
  await writeFile(empty, '')
  await assert.rejects(readGuestEvidenceFile(empty), /empty or exceeds/u)
})

test('file reader rejects symbolic-link indirection when the platform permits creating it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ue-webui-clean-link-'))
  const target = join(directory, 'target.json')
  const link = join(directory, 'link.json')
  await writeFile(target, JSON.stringify(makeGuest('ue54')), 'utf8')
  try {
    await symlink(target, link, 'file')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('The current Windows account cannot create symbolic links.')
      return
    }
    throw error
  }
  await assert.rejects(readGuestEvidenceFile(link), /reparse indirection/u)
})
