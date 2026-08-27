import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  downloadVerifiedArtifactArchive,
  downloadVerifiedArtifactPair,
} from '../scripts/resolve-ue-release-artifact.mjs'

const RESOLVER_PATH = fileURLToPath(
  new URL('../scripts/resolve-ue-release-artifact.mjs', import.meta.url),
)
const commit = '1'.repeat(40)

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

test('downloads the exact artifact ZIP and publishes it only after SHA-256 verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unreal-webui-artifact-test-'))
  const outputPath = join(directory, 'trusted-package.zip')
  const archive = Buffer.from('PK\u0003\u0004trusted artifact test payload')
  let request

  try {
    const result = await downloadVerifiedArtifactArchive({
      artifactId: 42,
      expectedDigest: sha256(archive),
      fetchImpl: async (url, options) => {
        request = { options, url }
        return new Response(archive, { status: 200 })
      },
      outputPath,
      repository: 'owner/repository',
      token: 'test-token',
    })

    assert.equal(
      request.url,
      'https://api.github.com/repos/owner/repository/actions/artifacts/42/zip',
    )
    assert.equal(request.options.redirect, 'follow')
    assert.equal(request.options.headers.Authorization, 'Bearer test-token')
    assert.equal(result.digest, sha256(archive))
    assert.equal(result.sizeInBytes, archive.length)
    assert.deepEqual(await readFile(outputPath), archive)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('fails closed and leaves no archive when the downloaded ZIP digest mismatches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unreal-webui-artifact-test-'))
  const outputPath = join(directory, 'trusted-package.zip')
  const archive = Buffer.from('corrupted artifact bytes')

  try {
    await assert.rejects(
      downloadVerifiedArtifactArchive({
        artifactId: 43,
        expectedDigest: `sha256:${'0'.repeat(64)}`,
        fetchImpl: async () => new Response(archive, { status: 200 }),
        outputPath,
        repository: 'owner/repository',
        token: 'test-token',
      }),
      /Artifact 43 SHA-256 mismatch/,
    )

    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('publishes package and build-environment archives only after both digests verify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unreal-webui-artifact-pair-test-'))
  const packageOutputPath = join(directory, 'trusted-package.zip')
  const buildEnvironmentOutputPath = join(directory, 'trusted-build-environment.zip')
  const packageArchive = Buffer.from('PK\u0003\u0004trusted package bytes')
  const buildEnvironmentArchive = Buffer.from('PK\u0003\u0004trusted environment bytes')

  try {
    const result = await downloadVerifiedArtifactPair({
      buildEnvironmentArtifactId: 44,
      buildEnvironmentExpectedDigest: sha256(buildEnvironmentArchive),
      buildEnvironmentOutputPath,
      fetchImpl: async (url) => new Response(
        url.endsWith('/44/zip') ? buildEnvironmentArchive : packageArchive,
        { status: 200 },
      ),
      packageArtifactId: 42,
      packageExpectedDigest: sha256(packageArchive),
      packageOutputPath,
      repository: 'owner/repository',
      token: 'test-token',
    })

    assert.deepEqual(await readFile(packageOutputPath), packageArchive)
    assert.deepEqual(await readFile(buildEnvironmentOutputPath), buildEnvironmentArchive)
    assert.equal(result.package.path, packageOutputPath)
    assert.equal(result.buildEnvironment.path, buildEnvironmentOutputPath)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('leaves neither final archive when the second artifact digest mismatches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unreal-webui-artifact-pair-test-'))
  const packageOutputPath = join(directory, 'trusted-package.zip')
  const buildEnvironmentOutputPath = join(directory, 'trusted-build-environment.zip')
  const packageArchive = Buffer.from('PK\u0003\u0004trusted package bytes')
  const buildEnvironmentArchive = Buffer.from('corrupted environment bytes')

  try {
    await assert.rejects(
      downloadVerifiedArtifactPair({
        buildEnvironmentArtifactId: 44,
        buildEnvironmentExpectedDigest: `sha256:${'0'.repeat(64)}`,
        buildEnvironmentOutputPath,
        fetchImpl: async (url) => new Response(
          url.endsWith('/44/zip') ? buildEnvironmentArchive : packageArchive,
          { status: 200 },
        ),
        packageArtifactId: 42,
        packageExpectedDigest: sha256(packageArchive),
        packageOutputPath,
        repository: 'owner/repository',
        token: 'test-token',
      }),
      /Artifact 44 SHA-256 mismatch/u,
    )

    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('preflights both pair destinations without changing an existing archive', async () => {
  for (const preexistingName of ['trusted-package.zip', 'trusted-build-environment.zip']) {
    const directory = await mkdtemp(join(tmpdir(), 'unreal-webui-artifact-pair-test-'))
    const packageOutputPath = join(directory, 'trusted-package.zip')
    const buildEnvironmentOutputPath = join(directory, 'trusted-build-environment.zip')
    const preexistingPath = join(directory, preexistingName)
    const original = Buffer.from(`preserve ${preexistingName}`)
    let fetchCalls = 0

    try {
      await writeFile(preexistingPath, original, { flag: 'wx' })
      await assert.rejects(
        downloadVerifiedArtifactPair({
          buildEnvironmentArtifactId: 44,
          buildEnvironmentExpectedDigest: `sha256:${'4'.repeat(64)}`,
          buildEnvironmentOutputPath,
          fetchImpl: async () => {
            fetchCalls += 1
            return new Response('unexpected', { status: 200 })
          },
          packageArtifactId: 42,
          packageExpectedDigest: `sha256:${'2'.repeat(64)}`,
          packageOutputPath,
          repository: 'owner/repository',
          token: 'test-token',
        }),
        /Refusing to overwrite existing artifact archive/u,
      )

      assert.equal(fetchCalls, 0)
      assert.deepEqual(await readFile(preexistingPath), original)
      assert.deepEqual(await readdir(directory), [preexistingName])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }
})

test('CLI requires one fresh directory for the closed six-artifact set', () => {
  const baseArguments = [
    RESOLVER_PATH,
    '--repository',
    'owner/repository',
    '--commit',
    commit,
  ]
  const result = spawnSync(process.execPath, baseArguments, {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_TOKEN: '' },
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /--download-directory is required/u)
})

test('CLI rejects duplicate download-directory arguments', () => {
  const result = spawnSync(
    process.execPath,
    [
      RESOLVER_PATH,
      '--repository',
      'owner/repository',
      '--commit',
      commit,
      '--download-directory',
      'first',
      '--download-directory',
      'second',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '' },
    },
  )

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /Expected --name value arguments/u)
})
