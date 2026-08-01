import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'

import { downloadVerifiedArtifactArchive } from '../scripts/resolve-ue-release-artifact.mjs'

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
