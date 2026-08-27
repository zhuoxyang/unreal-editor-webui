import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REGISTRY_PATH = new URL('./ue-release-variants.json', import.meta.url)
const IDENTIFIER_PATTERN = /^ue[0-9]{2}$/u
const RELEASE_VARIANT_PATTERN = /^UE[0-9]{2}-Win64$/u
const ENGINE_ASSOCIATION_PATTERN = /^5\.[0-9]+$/u
const THREE_PART_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u
const FOUR_PART_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/u
const WINDOWS_SDK_PATTERN = /^10\.0\.[1-9][0-9]*\.0$/u
const CEF_PRODUCT_PATTERN = /^[0-9A-Za-z.+-]+$/u
const SHA256_ARTIFACT_PREFIXES = Object.freeze([
  'UnrealEditorWebUI-Package-',
  'UnrealEditorWebUI-BuildEnvironment-',
])

function fail(message) {
  throw new Error(`UE release variant registry is invalid: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`)
  const actual = Object.keys(value)
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} contains an unexpected or missing field.`)
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(`${label} must be a non-empty string.`)
  }
  return value
}

function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a safe integer.`)
  return value
}

function parseRegistry() {
  let document
  try {
    document = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
  } catch {
    fail('the JSON file cannot be read or decoded.')
  }
  exactKeys(document, ['schemaVersion', 'variants'], 'registry')
  if (document.schemaVersion !== 1 || !Array.isArray(document.variants)) {
    fail('schemaVersion must be 1 and variants must be an array.')
  }
  if (document.variants.length !== 3) fail('exactly three variants are required.')

  const variants = document.variants.map((variant, index) => {
    const label = `variants[${index}]`
    exactKeys(
      variant,
      [
        'id',
        'releaseVariant',
        'engineAssociation',
        'engineRoot',
        'runnerLabel',
        'jobName',
        'packageArtifactName',
        'buildEnvironmentArtifactName',
        'engine',
        'toolchain',
        'embeddedPythonVersion',
        'cefProductVersion',
        'cefChromiumVersion',
      ],
      label,
    )
    exactKeys(
      variant.engine,
      [
        'majorVersion',
        'minorVersion',
        'patchVersion',
        'changelist',
        'compatibleChangelist',
        'branchName',
        'buildId',
      ],
      `${label}.engine`,
    )
    exactKeys(
      variant.toolchain,
      ['visualStudioVersion', 'familyVersion', 'productVersion', 'windowsSdkVersion'],
      `${label}.toolchain`,
    )

    const id = nonEmptyString(variant.id, `${label}.id`)
    const releaseVariant = nonEmptyString(variant.releaseVariant, `${label}.releaseVariant`)
    const engineAssociation = nonEmptyString(
      variant.engineAssociation,
      `${label}.engineAssociation`,
    )
    if (!IDENTIFIER_PATTERN.test(id) || !RELEASE_VARIANT_PATTERN.test(releaseVariant)) {
      fail(`${label} has an invalid id or releaseVariant.`)
    }
    if (!ENGINE_ASSOCIATION_PATTERN.test(engineAssociation)) {
      fail(`${label}.engineAssociation is invalid.`)
    }
    const associationParts = engineAssociation.split('.').map(Number)
    const expectedId = `ue${associationParts[0]}${associationParts[1]}`
    const expectedReleaseVariant = `UE${associationParts[0]}${associationParts[1]}-Win64`
    if (
      variant.engine.majorVersion !== associationParts[0] ||
      variant.engine.minorVersion !== associationParts[1]
    ) {
      fail(`${label} engine identity does not match engineAssociation.`)
    }
    if (
      id !== expectedId ||
      releaseVariant !== expectedReleaseVariant ||
      variant.engineRoot !== `C:\\Program Files\\Epic Games\\UE_${engineAssociation}` ||
      variant.runnerLabel !== `ue-${engineAssociation}` ||
      variant.jobName !== `UE ${engineAssociation} BuildPlugin and automation` ||
      variant.packageArtifactName !== `UnrealEditorWebUI-Package-${expectedReleaseVariant}` ||
      variant.buildEnvironmentArtifactName !==
        `UnrealEditorWebUI-BuildEnvironment-${expectedReleaseVariant}`
    ) {
      fail(`${label} identity fields are not derived from engineAssociation.`)
    }
    for (const [key, value] of Object.entries(variant.engine)) {
      if (['branchName', 'buildId'].includes(key)) nonEmptyString(value, `${label}.engine.${key}`)
      else safeNonNegativeInteger(value, `${label}.engine.${key}`)
    }
    if (variant.engine.changelist <= 0 || !/^[1-9][0-9]*$/u.test(variant.engine.buildId)) {
      fail(`${label} changelist and buildId must be positive.`)
    }
    if (
      variant.engine.compatibleChangelist !== 0 &&
      variant.engine.compatibleChangelist > variant.engine.changelist
    ) {
      fail(`${label}.engine.compatibleChangelist is invalid.`)
    }
    for (const [key, value] of Object.entries(variant.toolchain)) {
      nonEmptyString(value, `${label}.toolchain.${key}`)
    }
    if (variant.engine.branchName !== `++UE5+Release-${engineAssociation}`) {
      fail(`${label}.engine.branchName does not match engineAssociation.`)
    }
    const familyVersion = variant.toolchain.familyVersion
    const productVersion = variant.toolchain.productVersion
    if (
      variant.toolchain.visualStudioVersion !== '2022' ||
      !THREE_PART_VERSION_PATTERN.test(familyVersion) ||
      !THREE_PART_VERSION_PATTERN.test(productVersion) ||
      familyVersion.split('.').slice(0, 2).join('.') !==
        productVersion.split('.').slice(0, 2).join('.') ||
      !WINDOWS_SDK_PATTERN.test(variant.toolchain.windowsSdkVersion)
    ) {
      fail(`${label}.toolchain does not contain a supported closed version tuple.`)
    }
    if (
      !THREE_PART_VERSION_PATTERN.test(variant.embeddedPythonVersion) ||
      !FOUR_PART_VERSION_PATTERN.test(variant.cefChromiumVersion) ||
      !CEF_PRODUCT_PATTERN.test(variant.cefProductVersion) ||
      !variant.cefProductVersion.includes(`chromium-${variant.cefChromiumVersion}`)
    ) {
      fail(`${label} runtime versions are invalid or inconsistent.`)
    }
    for (const key of [
      'engineRoot',
      'runnerLabel',
      'jobName',
      'packageArtifactName',
      'buildEnvironmentArtifactName',
      'embeddedPythonVersion',
      'cefProductVersion',
      'cefChromiumVersion',
    ]) {
      nonEmptyString(variant[key], `${label}.${key}`)
    }
    if (!variant.packageArtifactName.endsWith(releaseVariant)) {
      fail(`${label}.packageArtifactName does not match releaseVariant.`)
    }
    if (!variant.buildEnvironmentArtifactName.endsWith(releaseVariant)) {
      fail(`${label}.buildEnvironmentArtifactName does not match releaseVariant.`)
    }
    return Object.freeze({
      ...variant,
      engine: Object.freeze({ ...variant.engine }),
      toolchain: Object.freeze({ ...variant.toolchain }),
      runnerLabels: Object.freeze(['self-hosted', 'windows', 'gui', variant.runnerLabel]),
    })
  })

  const expectedIdentities = [
    ['ue54', '5.4'],
    ['ue55', '5.5'],
    ['ue58', '5.8'],
  ]
  if (
    variants.some(
      (variant, index) =>
        variant.id !== expectedIdentities[index][0] ||
        variant.engineAssociation !== expectedIdentities[index][1],
    )
  ) {
    fail('variants must use the closed ue54/5.4, ue55/5.5, ue58/5.8 order.')
  }

  for (const key of [
    'id',
    'releaseVariant',
    'engineAssociation',
    'runnerLabel',
    'jobName',
    'packageArtifactName',
    'buildEnvironmentArtifactName',
  ]) {
    if (new Set(variants.map((variant) => variant[key])).size !== variants.length) {
      fail(`${key} values must be unique.`)
    }
  }
  for (const variant of variants) {
    if (
      !variant.packageArtifactName.startsWith(SHA256_ARTIFACT_PREFIXES[0]) ||
      !variant.buildEnvironmentArtifactName.startsWith(SHA256_ARTIFACT_PREFIXES[1])
    ) fail(`${variant.id} artifact prefixes are invalid.`)
  }
  return Object.freeze(variants)
}

export const RELEASE_VARIANTS = parseRegistry()
export const RELEASE_VARIANT_BY_ID = Object.freeze(
  Object.fromEntries(RELEASE_VARIANTS.map((variant) => [variant.id, variant])),
)

export function requireReleaseVariant(id) {
  if (typeof id !== 'string' || !Object.hasOwn(RELEASE_VARIANT_BY_ID, id)) {
    throw new Error(`Unsupported UE release variant '${id}'.`)
  }
  return RELEASE_VARIANT_BY_ID[id]
}

export function releaseWorkflowMatrix() {
  return {
    include: RELEASE_VARIANTS.map((variant) => ({
      variant_id: variant.id,
      release_variant: variant.releaseVariant,
      ue_version: variant.engineAssociation,
      ue_root: variant.engineRoot,
      runner_label: variant.runnerLabel,
      job_name: variant.jobName,
      package_artifact: variant.packageArtifactName,
      build_environment_artifact: variant.buildEnvironmentArtifactName,
      patch_version: variant.engine.patchVersion,
      changelist: variant.engine.changelist,
      compatible_changelist: variant.engine.compatibleChangelist,
      branch_name: variant.engine.branchName,
      build_id: variant.engine.buildId,
      python_version: variant.embeddedPythonVersion,
      cef_product_version: variant.cefProductVersion,
      cef_chromium_version: variant.cefChromiumVersion,
      visual_studio_version: variant.toolchain.visualStudioVersion,
      toolchain_family_version: variant.toolchain.familyVersion,
      compiler_product_version: variant.toolchain.productVersion,
      windows_sdk_version: variant.toolchain.windowsSdkVersion,
    })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== 'workflow-matrix') {
    console.error('Usage: ue-release-variants.mjs workflow-matrix')
    process.exitCode = 1
  } else {
    process.stdout.write(`${JSON.stringify(releaseWorkflowMatrix())}\n`)
  }
}
