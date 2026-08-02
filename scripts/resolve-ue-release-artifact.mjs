#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const EXPECTED_WORKFLOW_PATH = '.github/workflows/ue-ci.yml'
export const EXPECTED_JOB_NAME = 'UE 5.8 BuildPlugin and automation'
export const EXPECTED_ARTIFACT_NAME = 'UnrealEditorWebUI-Package-UE58'
export const EXPECTED_RUNNER_LABELS = ['self-hosted', 'windows', 'gui', 'ue-5.8']

function parseArguments(argv) {
  const result = new Map()

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`Expected --name value arguments, received '${key}'.`)
    }

    result.set(key.slice(2), argv[index + 1])
    index += 1
  }

  return result
}

function repositoryPath(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository)
  if (!match) {
    throw new Error(`Invalid repository '${repository}'. Expected owner/name.`)
  }

  return `${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
}

function expectedSha256(digest) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest ?? '')
  if (!match) {
    throw new Error(`Invalid expected artifact digest '${digest}'.`)
  }

  return match[1]
}

async function assertPathDoesNotExist(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }

  throw new Error(`Refusing to overwrite existing artifact archive '${path}'.`)
}

export async function downloadVerifiedArtifactArchive({
  artifactId,
  expectedDigest,
  fetchImpl = fetch,
  outputPath,
  repository,
  token,
}) {
  const numericArtifactId = Number(artifactId)
  if (!Number.isSafeInteger(numericArtifactId) || numericArtifactId <= 0) {
    throw new Error(`Invalid artifact id '${artifactId}'.`)
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to download the verified artifact archive.')
  }
  if (!outputPath) {
    throw new Error('A non-empty artifact archive output path is required.')
  }

  const repositoryApiPath = repositoryPath(repository)
  const expectedHash = expectedSha256(expectedDigest)
  const destinationPath = resolve(outputPath)
  const destinationDirectory = dirname(destinationPath)
  const temporaryPath = join(
    destinationDirectory,
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  )

  await mkdir(destinationDirectory, { recursive: true })
  await assertPathDoesNotExist(destinationPath)

  const apiPath = `/repos/${repositoryApiPath}/actions/artifacts/${numericArtifactId}/zip`
  const response = await fetchImpl(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'unreal-editor-webui-release-verifier',
      'X-GitHub-Api-Version': API_VERSION,
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500)
    throw new Error(`GitHub artifact download ${response.status} for ${apiPath}: ${responseText}`)
  }
  if (!response.body) {
    throw new Error(`GitHub artifact download for ${numericArtifactId} returned an empty body.`)
  }

  const hash = createHash('sha256')
  let downloadedBytes = 0
  const hashingStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      hashingStream,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    )

    if (downloadedBytes <= 0) {
      throw new Error(`GitHub artifact download for ${numericArtifactId} was empty.`)
    }

    const actualHash = hash.digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(
        `Artifact ${numericArtifactId} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}.`,
      )
    }

    await rename(temporaryPath, destinationPath)
    return {
      digest: `sha256:${actualHash}`,
      path: destinationPath,
      sizeInBytes: downloadedBytes,
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function githubJson(token, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'unreal-editor-webui-release-verifier',
      'X-GitHub-Api-Version': API_VERSION,
    },
  })

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500)
    throw new Error(`GitHub API ${response.status} for ${apiPath}: ${responseText}`)
  }

  return response.json()
}

export async function githubCollection(
  token,
  initialPath,
  propertyName,
  githubJsonImpl = githubJson,
) {
  const values = []
  let page = 1

  while (true) {
    const separator = initialPath.includes('?') ? '&' : '?'
    const response = await githubJsonImpl(
      token,
      `${initialPath}${separator}per_page=100&page=${page}`,
    )
    const pageValues = response[propertyName]
    if (!Array.isArray(pageValues)) {
      throw new Error(`GitHub API response did not contain '${propertyName}'.`)
    }

    values.push(...pageValues)
    if (pageValues.length < 100) {
      return values
    }

    page += 1
  }
}

export function validateRunMetadata(run, repository, commit) {
  const errors = []

  if (run.path !== EXPECTED_WORKFLOW_PATH) {
    errors.push(`workflow path is '${run.path}', expected '${EXPECTED_WORKFLOW_PATH}'`)
  }
  if (run.head_sha?.toLowerCase() !== commit) {
    errors.push(`head SHA is '${run.head_sha}', expected '${commit}'`)
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    errors.push(`run state is ${run.status}/${run.conclusion}, expected completed/success`)
  }
  if (!['push', 'workflow_dispatch'].includes(run.event)) {
    errors.push(`event '${run.event}' is not trusted for UE release validation`)
  }
  if (run.event === 'push' && run.head_branch !== 'main') {
    errors.push(`push validation came from '${run.head_branch}', expected main`)
  }
  if (run.head_repository?.full_name !== repository) {
    errors.push(`head repository is '${run.head_repository?.full_name}', expected '${repository}'`)
  }

  if (errors.length > 0) {
    throw new Error(`UE workflow run ${run.id} is not eligible: ${errors.join('; ')}.`)
  }
}

export function validateReleaseCandidate({ artifacts, commit, jobs, repository, run }) {
  validateRunMetadata(run, repository, commit)

  const expectedJobs = jobs.filter((job) => job.name === EXPECTED_JOB_NAME)
  if (expectedJobs.length !== 1 || expectedJobs[0].conclusion !== 'success') {
    const conclusions = expectedJobs.map((job) => job.conclusion).join(', ') || 'missing'
    throw new Error(
      `UE workflow run ${run.id} does not contain exactly one successful '${EXPECTED_JOB_NAME}' job (found ${conclusions}).`,
    )
  }

  const expectedJob = expectedJobs[0]
  const jobLabels = new Set(
    (Array.isArray(expectedJob.labels) ? expectedJob.labels : [])
      .filter((label) => typeof label === 'string')
      .map((label) => label.toLowerCase()),
  )
  const missingLabels = EXPECTED_RUNNER_LABELS.filter(
    (label) => !jobLabels.has(label),
  )
  if (missingLabels.length > 0 || !expectedJob.runner_name) {
    throw new Error(
      `UE job ${expectedJob.id} was not assigned to the required trusted runner labels (missing: ${missingLabels.join(', ') || 'none'}).`,
    )
  }

  const expectedArtifacts = artifacts.filter((artifact) => artifact.name === EXPECTED_ARTIFACT_NAME)
  if (expectedArtifacts.length !== 1) {
    throw new Error(
      `UE workflow run ${run.id} must contain exactly one '${EXPECTED_ARTIFACT_NAME}' artifact; found ${expectedArtifacts.length}.`,
    )
  }

  const artifact = expectedArtifacts[0]
  if (artifact.expired) {
    throw new Error(`UE artifact ${artifact.id} from run ${run.id} has expired.`)
  }
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
    throw new Error(`UE artifact ${artifact.id} from run ${run.id} is empty.`)
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) {
    throw new Error(`UE artifact ${artifact.id} does not expose a valid immutable SHA-256 digest.`)
  }
  if (!artifact.workflow_run || typeof artifact.workflow_run !== 'object') {
    throw new Error(`UE artifact ${artifact.id} does not expose its workflow-run binding.`)
  }
  if (!Number.isSafeInteger(artifact.workflow_run.id) || artifact.workflow_run.id !== run.id) {
    throw new Error(`UE artifact ${artifact.id} is not bound to workflow run ${run.id}.`)
  }
  if (
    typeof artifact.workflow_run.head_sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(artifact.workflow_run.head_sha) ||
    artifact.workflow_run.head_sha.toLowerCase() !== commit
  ) {
    throw new Error(`UE artifact ${artifact.id} is not bound to commit ${commit}.`)
  }

  return { artifact, job: expectedJob, run }
}

async function validateRun(token, repository, repositoryApiPath, commit, run) {
  const jobs = await githubCollection(
    token,
    `/repos/${repositoryApiPath}/actions/runs/${run.id}/jobs`,
    'jobs',
  )
  const artifacts = await githubCollection(
    token,
    `/repos/${repositoryApiPath}/actions/runs/${run.id}/artifacts`,
    'artifacts',
  )

  return validateReleaseCandidate({ artifacts, commit, jobs, repository, run })
}

function writeOutputs(selection) {
  const outputs = [
    `ue_run_id=${selection.run.id}`,
    `ue_run_url=${selection.run.html_url}`,
    `ue_job_id=${selection.job.id}`,
    `ue_artifact_id=${selection.artifact.id}`,
    `ue_artifact_digest=${selection.artifact.digest}`,
    `ue_artifact_name=${selection.artifact.name}`,
  ]

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`, 'utf8')
  }

  console.log(
    JSON.stringify(
      {
        artifactId: selection.artifact.id,
        artifactDigest: selection.artifact.digest,
        artifactName: selection.artifact.name,
        commit: selection.run.head_sha,
        jobId: selection.job.id,
        runId: selection.run.id,
        runUrl: selection.run.html_url,
      },
      null,
      2,
    ),
  )
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2))
  const repository = argumentsMap.get('repository') ?? process.env.GITHUB_REPOSITORY ?? ''
  const commit = (argumentsMap.get('commit') ?? process.env.RELEASE_COMMIT ?? '').toLowerCase()
  const requestedRunId = argumentsMap.get('run-id') ?? ''
  const archiveOutputPath = argumentsMap.get('download-to') ?? ''
  const token = process.env.GITHUB_TOKEN ?? ''

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid release commit '${commit}'. Expected a full 40-character Git SHA.`)
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to verify UE workflow metadata and artifacts.')
  }
  if (requestedRunId && !/^[1-9][0-9]*$/.test(requestedRunId)) {
    throw new Error(`Invalid workflow run id '${requestedRunId}'.`)
  }

  const repositoryApiPath = repositoryPath(repository)
  let candidateRuns
  if (requestedRunId) {
    candidateRuns = [
      await githubJson(token, `/repos/${repositoryApiPath}/actions/runs/${requestedRunId}`),
    ]
  } else {
    candidateRuns = await githubCollection(
      token,
      `/repos/${repositoryApiPath}/actions/workflows/ue-ci.yml/runs?head_sha=${commit}&status=success`,
      'workflow_runs',
    )
    candidateRuns.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
  }

  if (candidateRuns.length === 0) {
    throw new Error(`No successful UE CI workflow run exists for commit ${commit}.`)
  }

  const validationErrors = []
  let selection
  for (const run of candidateRuns) {
    try {
      selection = await validateRun(token, repository, repositoryApiPath, commit, run)
      break
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : String(error))
      if (requestedRunId) {
        break
      }
    }
  }

  if (!selection) {
    throw new Error(
      `No fail-closed UE artifact is eligible for commit ${commit}: ${validationErrors.join(' | ')}`,
    )
  }

  if (archiveOutputPath) {
    const download = await downloadVerifiedArtifactArchive({
      artifactId: selection.artifact.id,
      expectedDigest: selection.artifact.digest,
      outputPath: archiveOutputPath,
      repository,
      token,
    })
    console.log(
      `Verified ${download.sizeInBytes} artifact bytes against ${download.digest} before writing ${download.path}.`,
    )
  }

  writeOutputs(selection)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
