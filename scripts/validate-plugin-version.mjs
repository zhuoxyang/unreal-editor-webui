import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

export function parseReleaseVersion(rawVersion) {
  if (typeof rawVersion !== 'string') return null

  const match = RELEASE_VERSION_PATTERN.exec(rawVersion)
  if (!match || match[0] !== rawVersion) return null

  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null

  const prerelease = match[4]?.split('.') ?? []
  for (const identifier of prerelease) {
    if (/^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      return null
    }
  }

  return { major, minor, patch, prerelease }
}

export function compareReleaseVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1
    }
    if (leftIdentifier === rightIdentifier) continue

    const leftIsNumeric = /^[0-9]+$/u.test(leftIdentifier)
    const rightIsNumeric = /^[0-9]+$/u.test(rightIdentifier)
    if (leftIsNumeric && rightIsNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length < rightIdentifier.length ? -1 : 1
      }
      return leftIdentifier < rightIdentifier ? -1 : 1
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }

  return 0
}

export function validatePluginDescriptor(descriptor, label = 'plugin descriptor') {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error(`${label} must contain a JSON object.`)
  }
  if (!Number.isSafeInteger(descriptor.Version) || descriptor.Version <= 0) {
    throw new Error(`${label} Version must be a positive safe integer.`)
  }

  const parsedVersionName = parseReleaseVersion(descriptor.VersionName)
  if (!parsedVersionName) {
    throw new Error(
      `${label} VersionName must be a canonical semantic version without build metadata.`,
    )
  }

  return {
    integerVersion: descriptor.Version,
    parsedVersionName,
    versionName: descriptor.VersionName,
  }
}

export function validateMatchingPluginDescriptors(
  sourceDescriptor,
  packagedDescriptor,
  packagedLabel = 'packaged plugin descriptor',
) {
  const source = validatePluginDescriptor(sourceDescriptor, 'source plugin descriptor')
  const packaged = validatePluginDescriptor(packagedDescriptor, packagedLabel)

  if (packaged.integerVersion !== source.integerVersion) {
    throw new Error(
      `${packagedLabel} Version ${packaged.integerVersion} does not match source ` +
        `Version ${source.integerVersion}.`,
    )
  }
  if (packaged.versionName !== source.versionName) {
    throw new Error(
      `${packagedLabel} VersionName '${packaged.versionName}' does not match source ` +
        `VersionName '${source.versionName}'.`,
    )
  }

  return { packaged, source }
}

export function validateVersionHistory(currentDescriptor, taggedDescriptors) {
  const current = validatePluginDescriptor(currentDescriptor, 'current plugin descriptor')
  const releases = taggedDescriptors.map(({ descriptor, tag }) => {
    if (typeof tag !== 'string' || !tag.startsWith('v')) {
      throw new Error(`Release tag '${String(tag)}' must start with v.`)
    }

    const release = validatePluginDescriptor(descriptor, `descriptor at ${tag}`)
    if (tag !== `v${release.versionName}`) {
      throw new Error(
        `Release tag '${tag}' does not match its descriptor VersionName '${release.versionName}'.`,
      )
    }
    return { ...release, tag }
  })

  releases.sort((left, right) =>
    compareReleaseVersions(left.parsedVersionName, right.parsedVersionName),
  )

  if (current.integerVersion > 1 && releases.length === 0) {
    throw new Error(
      `Current Version ${current.integerVersion} requires reachable release-tag history.`,
    )
  }

  for (let index = 1; index < releases.length; index += 1) {
    const previous = releases[index - 1]
    const next = releases[index]
    if (compareReleaseVersions(previous.parsedVersionName, next.parsedVersionName) === 0) {
      throw new Error(`Release tags '${previous.tag}' and '${next.tag}' have equal precedence.`)
    }
    if (next.integerVersion <= previous.integerVersion) {
      throw new Error(
        `${next.tag} Version ${next.integerVersion} must be greater than ` +
          `${previous.tag} Version ${previous.integerVersion}.`,
      )
    }
  }

  const latest = releases.at(-1) ?? null
  if (latest) {
    const comparison = compareReleaseVersions(
      current.parsedVersionName,
      latest.parsedVersionName,
    )
    if (comparison < 0) {
      throw new Error(
        `Current VersionName '${current.versionName}' is older than latest release ${latest.tag}.`,
      )
    }
    if (comparison === 0 && current.integerVersion !== latest.integerVersion) {
      throw new Error(
        `Current ${latest.tag} Version ${current.integerVersion} must equal released ` +
          `Version ${latest.integerVersion}.`,
      )
    }
    if (comparison > 0 && current.integerVersion <= latest.integerVersion) {
      throw new Error(
        `Current Version ${current.integerVersion} must be greater than latest release ` +
          `${latest.tag} Version ${latest.integerVersion}.`,
      )
    }
  }

  return { current, latest, releases }
}

function readTaggedDescriptors(repositoryRoot, descriptorPath) {
  const relativeDescriptorPath = relative(repositoryRoot, descriptorPath)
  if (
    relativeDescriptorPath === '' ||
    relativeDescriptorPath === '..' ||
    relativeDescriptorPath.startsWith(`..${sep}`)
  ) {
    throw new Error('Plugin descriptor must be inside the repository root.')
  }

  const gitDescriptorPath = relativeDescriptorPath.split(sep).join('/')
  const tags = execFileSync(
    'git',
    ['tag', '--merged', 'HEAD', '--list', 'v*'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .filter(Boolean)

  return tags.map((tag) => ({
    descriptor: JSON.parse(
      execFileSync('git', ['show', `${tag}:${gitDescriptorPath}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }),
    ),
    tag,
  }))
}

function runCli() {
  try {
    const { values } = parseArgs({
      options: {
        'compare-descriptor': { type: 'string' },
        descriptor: { type: 'string' },
        tag: { type: 'string' },
      },
      strict: true,
    })
    const repositoryRoot = process.cwd()
    const descriptorPath = resolve(repositoryRoot, values.descriptor ?? 'UnrealEditorWebUI.uplugin')
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    const history = readTaggedDescriptors(repositoryRoot, descriptorPath)
    const { current } = validateVersionHistory(descriptor, history)

    if (values.tag && values.tag !== `v${current.versionName}`) {
      throw new Error(
        `Release tag '${values.tag}' does not match current VersionName '${current.versionName}'.`,
      )
    }

    if (values['compare-descriptor']) {
      const comparisonPath = resolve(repositoryRoot, values['compare-descriptor'])
      const comparisonDescriptor = JSON.parse(readFileSync(comparisonPath, 'utf8'))
      validateMatchingPluginDescriptors(
        descriptor,
        comparisonDescriptor,
        values['compare-descriptor'],
      )
    }

    console.log(
      `Plugin ${current.versionName} (Version ${current.integerVersion}) is valid and monotonic ` +
        `across ${history.length} reachable release tag(s).`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli()
}
