import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isSupportedNodeVersion,
  NODE_ENGINE_RANGE,
  parseNodeVersion,
  SUPPORTED_NODE_FLOORS,
} from '../scripts/validate-node-version.mjs'

const REPOSITORY_ROOT = new URL('../', import.meta.url)

function readRepositoryFile(path) {
  return readFileSync(new URL(path, REPOSITORY_ROOT), 'utf8')
}

function supportedFloorVersions() {
  return SUPPORTED_NODE_FLOORS.map(
    ({ major, minor, patch }) => `${major}.${minor}.${patch}`,
  )
}

test('declares closed major ranges for the supported Node.js floors', () => {
  assert.deepEqual(SUPPORTED_NODE_FLOORS, [
    { major: 22, minor: 22, patch: 2 },
    { major: 24, minor: 18, patch: 1 },
  ])
  assert.equal(NODE_ENGINE_RANGE, '^22.22.2 || ^24.18.1')
})

test('strictly parses complete stable Node.js versions', () => {
  assert.deepEqual(parseNodeVersion('22.22.2'), { major: 22, minor: 22, patch: 2 })
  assert.deepEqual(parseNodeVersion('24.18.1'), { major: 24, minor: 18, patch: 1 })

  for (const version of [
    '',
    '22',
    '22.22',
    'v22.22.2',
    '022.22.2',
    '22.022.2',
    '22.22.02',
    '22.22.2-rc.1',
    '22.22.2\n',
    '22.22.2.0',
  ]) {
    assert.equal(parseNodeVersion(version), null, version)
  }
  assert.equal(parseNodeVersion(null), null)
  assert.equal(parseNodeVersion(22), null)
})

test('accepts supported floors and later releases within the same declared major', () => {
  for (const version of [
    '22.22.2',
    '22.22.3',
    '22.23.0',
    '24.18.1',
    '24.18.2',
    '24.19.0',
  ]) {
    assert.equal(isSupportedNodeVersion(version), true, version)
  }
})

test('rejects versions below a floor and every undeclared major', () => {
  for (const version of [
    '20.19.0',
    '22.22.1',
    '23.99.99',
    '24.18.0',
    '25.99.99',
    '26.0.0',
    '999.0.0',
    'not-a-version',
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, version)
  }
})

test('keeps package manifests and the release runtime on the supported contract', () => {
  const packageJson = JSON.parse(readRepositoryFile('frontend/package.json'))
  const packageLock = JSON.parse(readRepositoryFile('frontend/package-lock.json'))
  const npmConfig = readRepositoryFile('frontend/.npmrc')
  const nvmVersion = readRepositoryFile('.nvmrc').trim()
  const floors = supportedFloorVersions()

  assert.equal(packageJson.engines?.node, NODE_ENGINE_RANGE)
  assert.equal(packageLock.packages?.['']?.engines?.node, NODE_ENGINE_RANGE)
  assert.equal(packageJson.devDependencies?.['@types/node'], '22.20.1')
  assert.equal(packageLock.packages?.['node_modules/@types/node']?.version, '22.20.1')
  assert.match(npmConfig, /^engine-strict=true$/mu)
  assert.ok(floors.includes(nvmVersion), `.nvmrc must pin a CI-tested floor, received ${nvmVersion}`)
  assert.equal(isSupportedNodeVersion(nvmVersion), true)
})

test('runs CI on every declared floor and no undeclared Node.js major', () => {
  const workflow = readRepositoryFile('.github/workflows/ci.yml')
  const matrixMatch = /^\s*node-version:\s*(\[[^\r\n]+\])\s*$/mu.exec(workflow)

  assert.ok(matrixMatch, 'CI must declare the frontend Node.js matrix on one line')
  assert.deepEqual(JSON.parse(matrixMatch[1]), supportedFloorVersions())
})

test('uses the pinned release runtime for UE and release validation', () => {
  const releaseWorkflow = readRepositoryFile('.github/workflows/release-candidate.yml')
  const ueWorkflow = readRepositoryFile('.github/workflows/ue-ci.yml')

  assert.match(releaseWorkflow, /node-version-file: "\.nvmrc"/u)
  assert.match(releaseWorkflow, /node scripts\/validate-node-version\.mjs/u)
  assert.equal((ueWorkflow.match(/node-version-file: "\.nvmrc"/gu) || []).length, 2)
  assert.ok(
    (ueWorkflow.match(/node scripts\/validate-node-version\.mjs/gu) || []).length >= 2,
    'Every UE Node.js setup must run the repository version validator',
  )
})
