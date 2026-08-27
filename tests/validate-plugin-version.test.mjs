import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  compareReleaseVersions,
  parseReleaseVersion,
  validateMatchingPluginDescriptors,
  validatePluginDescriptor,
  validateVersionHistory,
} from '../scripts/validate-plugin-version.mjs'

const REPOSITORY_ROOT = new URL('../', import.meta.url)

function descriptor(version, versionName) {
  return { Version: version, VersionName: versionName }
}

function parsed(versionName) {
  const value = parseReleaseVersion(versionName)
  assert.ok(value, versionName)
  return value
}

test('strictly parses canonical release versions', () => {
  assert.deepEqual(parseReleaseVersion('0.1.1'), {
    major: 0,
    minor: 1,
    patch: 1,
    prerelease: [],
  })
  assert.deepEqual(parseReleaseVersion('2.0.0-rc.1'), {
    major: 2,
    minor: 0,
    patch: 0,
    prerelease: ['rc', '1'],
  })

  for (const version of [
    '',
    'v0.1.1',
    '01.1.1',
    '0.01.1',
    '0.1.01',
    '0.1',
    '0.1.1.0',
    '0.1.1-',
    '0.1.1-rc..1',
    '0.1.1-rc.01',
    '0.1.1+build.1',
    '0.1.1\n',
  ]) {
    assert.equal(parseReleaseVersion(version), null, version)
  }
  assert.equal(parseReleaseVersion(null), null)
})

test('orders stable and prerelease versions by semantic precedence', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
  ]

  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(
      compareReleaseVersions(parsed(ordered[index - 1]), parsed(ordered[index])),
      -1,
      `${ordered[index - 1]} < ${ordered[index]}`,
    )
  }
  assert.equal(compareReleaseVersions(parsed('1.0.0'), parsed('1.0.0')), 0)
})

test('requires positive integer and canonical semantic metadata', () => {
  assert.deepEqual(validatePluginDescriptor(descriptor(2, '0.1.1')), {
    integerVersion: 2,
    parsedVersionName: { major: 0, minor: 1, patch: 1, prerelease: [] },
    versionName: '0.1.1',
  })

  for (const version of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(
      () => validatePluginDescriptor(descriptor(version, '0.1.1')),
      /positive safe integer/u,
    )
  }
  assert.throws(
    () => validatePluginDescriptor(descriptor(2, 'version-two')),
    /canonical semantic version/u,
  )
})

test('accepts an unreleased version only when both metadata fields increase', () => {
  const result = validateVersionHistory(descriptor(2, '0.1.1'), [
    { tag: 'v0.1.0', descriptor: descriptor(1, '0.1.0') },
  ])

  assert.equal(result.current.integerVersion, 2)
  assert.equal(result.latest?.tag, 'v0.1.0')

  assert.throws(
    () => validateVersionHistory(descriptor(1, '0.1.1'), [
      { tag: 'v0.1.0', descriptor: descriptor(1, '0.1.0') },
    ]),
    /must be greater/u,
  )
  assert.throws(
    () => validateVersionHistory(descriptor(2, '0.1.0'), [
      { tag: 'v0.1.0', descriptor: descriptor(1, '0.1.0') },
    ]),
    /must equal released/u,
  )
  assert.throws(
    () => validateVersionHistory(descriptor(2, '0.1.1'), []),
    /requires reachable release-tag history/u,
  )
})

test('requires packaged metadata to match both source version fields', () => {
  assert.deepEqual(
    validateMatchingPluginDescriptors(
      descriptor(2, '0.1.1'),
      descriptor(2, '0.1.1'),
    ).packaged.versionName,
    '0.1.1',
  )
  assert.throws(
    () => validateMatchingPluginDescriptors(
      descriptor(2, '0.1.1'),
      descriptor(1, '0.1.1'),
    ),
    /does not match source Version 2/u,
  )
  assert.throws(
    () => validateMatchingPluginDescriptors(
      descriptor(2, '0.1.1'),
      descriptor(2, '0.1.0'),
    ),
    /does not match source VersionName '0\.1\.1'/u,
  )
})

test('rejects non-monotonic or mismatched tagged release history', () => {
  assert.throws(
    () => validateVersionHistory(descriptor(3, '0.1.2'), [
      { tag: 'v0.1.0', descriptor: descriptor(1, '0.1.0') },
      { tag: 'v0.1.1', descriptor: descriptor(1, '0.1.1') },
    ]),
    /must be greater/u,
  )
  assert.throws(
    () => validateVersionHistory(descriptor(3, '0.1.2'), [
      { tag: 'v0.1.1', descriptor: descriptor(2, '0.1.0') },
    ]),
    /does not match/u,
  )
  assert.throws(
    () => validateVersionHistory(descriptor(1, '0.0.9'), [
      { tag: 'v0.1.0', descriptor: descriptor(1, '0.1.0') },
    ]),
    /older than latest release/u,
  )
})

test('keeps repository metadata and workflows on the validated contract', () => {
  const currentDescriptor = JSON.parse(
    readFileSync(new URL('UnrealEditorWebUI.uplugin', REPOSITORY_ROOT), 'utf8'),
  )
  const ciWorkflow = readFileSync(
    new URL('.github/workflows/ci.yml', REPOSITORY_ROOT),
    'utf8',
  )
  const releaseWorkflow = readFileSync(
    new URL('.github/workflows/release-candidate.yml', REPOSITORY_ROOT),
    'utf8',
  )

  assert.equal(currentDescriptor.Version, 4)
  assert.equal(currentDescriptor.VersionName, '0.3.0')
  validatePluginDescriptor(currentDescriptor)
  assert.match(ciWorkflow, /node scripts\/validate-plugin-version\.mjs/u)
  assert.match(
    ciWorkflow,
    /repository:[\s\S]*?fetch-depth: 0[\s\S]*?node scripts\/validate-plugin-version\.mjs/u,
  )
  assert.match(
    releaseWorkflow,
    /node scripts\/validate-plugin-version\.mjs --tag "\$release_tag"/u,
  )
  assert.match(
    releaseWorkflow,
    /for variant_id in ue54 ue55 ue58; do[\s\S]*?package="trusted-packages\/\$variant_id"[\s\S]*?--compare-descriptor "\$package\/UnrealEditorWebUI\.uplugin"/u,
  )
})
