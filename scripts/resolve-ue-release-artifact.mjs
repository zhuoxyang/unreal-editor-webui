#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import { RELEASE_VARIANTS } from './ue-release-variants.mjs'

const API_VERSION = '2022-11-28'
const EXPECTED_WORKFLOW_PATH = '.github/workflows/ue-ci.yml'
export const EXPECTED_RELEASE_VARIANTS = RELEASE_VARIANTS
export const EXPECTED_JOB_NAME = RELEASE_VARIANTS[2].jobName
export const EXPECTED_ARTIFACT_NAME = RELEASE_VARIANTS[2].packageArtifactName
export const EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME =
  RELEASE_VARIANTS[2].buildEnvironmentArtifactName
export const EXPECTED_RUNNER_LABELS = RELEASE_VARIANTS[2].runnerLabels

function parseArguments(argv) {
  const result = new Map()

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (
      !key.startsWith('--') ||
      index + 1 >= argv.length ||
      result.has(key.slice(2))
    ) {
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
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }

  throw new Error(`Refusing to overwrite existing artifact archive '${path}'.`)
}

async function publishFileNoOverwrite(sourcePath, destinationPath) {
  try {
    await link(sourcePath, destinationPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing artifact archive '${destinationPath}'.`)
    }
    throw error
  }

  try {
    await rm(sourcePath)
  } catch (error) {
    await rm(destinationPath, { force: true })
    throw error
  }
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

    await publishFileNoOverwrite(temporaryPath, destinationPath)
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

  if (!Number.isSafeInteger(run.id) || run.id <= 0) {
    errors.push(`run id is '${run.id}', expected a safe positive integer`)
  }
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
    errors.push(`run attempt is '${run.run_attempt}', expected a safe positive integer`)
  }
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
  if (run.head_branch !== 'main') {
    errors.push(`validation came from '${run.head_branch}', expected main`)
  }
  if (run.head_repository?.full_name !== repository) {
    errors.push(`head repository is '${run.head_repository?.full_name}', expected '${repository}'`)
  }

  if (errors.length > 0) {
    throw new Error(`UE workflow run ${run.id} is not eligible: ${errors.join('; ')}.`)
  }
}

async function removeCreatedPaths(paths) {
  const cleanupErrors = []
  for (const path of paths) {
    try {
      await rm(path, { force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  return cleanupErrors
}

export async function downloadVerifiedArtifactPair({
  buildEnvironmentArtifactId,
  buildEnvironmentExpectedDigest,
  buildEnvironmentOutputPath,
  fetchImpl = fetch,
  packageArtifactId,
  packageExpectedDigest,
  packageOutputPath,
  repository,
  token,
}) {
  if (!packageOutputPath || !buildEnvironmentOutputPath) {
    throw new Error('Both package and build-environment artifact output paths are required.')
  }

  const packageDestinationPath = resolve(packageOutputPath)
  const buildEnvironmentDestinationPath = resolve(buildEnvironmentOutputPath)
  if (packageDestinationPath === buildEnvironmentDestinationPath) {
    throw new Error('Package and build-environment artifact archives require distinct output paths.')
  }

  await mkdir(dirname(packageDestinationPath), { recursive: true })
  await mkdir(dirname(buildEnvironmentDestinationPath), { recursive: true })
  await assertPathDoesNotExist(packageDestinationPath)
  await assertPathDoesNotExist(buildEnvironmentDestinationPath)

  const stagingSuffix = `${process.pid}.${randomUUID()}`
  const packageStagingPath = join(
    dirname(packageDestinationPath),
    `.${basename(packageDestinationPath)}.${stagingSuffix}.pair`,
  )
  const buildEnvironmentStagingPath = join(
    dirname(buildEnvironmentDestinationPath),
    `.${basename(buildEnvironmentDestinationPath)}.${stagingSuffix}.pair`,
  )
  const stagingPaths = [packageStagingPath, buildEnvironmentStagingPath]
  const publishedPaths = []

  try {
    const packageDownload = await downloadVerifiedArtifactArchive({
      artifactId: packageArtifactId,
      expectedDigest: packageExpectedDigest,
      fetchImpl,
      outputPath: packageStagingPath,
      repository,
      token,
    })
    const buildEnvironmentDownload = await downloadVerifiedArtifactArchive({
      artifactId: buildEnvironmentArtifactId,
      expectedDigest: buildEnvironmentExpectedDigest,
      fetchImpl,
      outputPath: buildEnvironmentStagingPath,
      repository,
      token,
    })

    await publishFileNoOverwrite(packageStagingPath, packageDestinationPath)
    publishedPaths.push(packageDestinationPath)
    await publishFileNoOverwrite(
      buildEnvironmentStagingPath,
      buildEnvironmentDestinationPath,
    )
    publishedPaths.push(buildEnvironmentDestinationPath)

    return {
      buildEnvironment: {
        ...buildEnvironmentDownload,
        path: buildEnvironmentDestinationPath,
      },
      package: {
        ...packageDownload,
        path: packageDestinationPath,
      },
    }
  } catch (error) {
    const cleanupErrors = await removeCreatedPaths([
      ...stagingPaths,
      ...publishedPaths.reverse(),
    ])
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Artifact pair verification failed and cleanup was incomplete.',
      )
    }
    throw error
  }
}

function validateBoundArtifact(artifact, expectedName, run, commit) {
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) {
    throw new Error(
      `UE artifact '${expectedName}' from run ${run.id} does not expose a safe positive id.`,
    )
  }
  if (artifact.expired !== false) {
    throw new Error(
      `UE artifact ${artifact.id} ('${expectedName}') from run ${run.id} is expired or lacks an explicit non-expired state.`,
    )
  }
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
    throw new Error(`UE artifact ${artifact.id} ('${expectedName}') from run ${run.id} is empty.`)
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) {
    throw new Error(
      `UE artifact ${artifact.id} ('${expectedName}') does not expose a valid immutable SHA-256 digest.`,
    )
  }
  if (!artifact.workflow_run || typeof artifact.workflow_run !== 'object') {
    throw new Error(
      `UE artifact ${artifact.id} ('${expectedName}') does not expose its workflow-run binding.`,
    )
  }
  if (!Number.isSafeInteger(artifact.workflow_run.id) || artifact.workflow_run.id !== run.id) {
    throw new Error(
      `UE artifact ${artifact.id} ('${expectedName}') is not bound to workflow run ${run.id}.`,
    )
  }
  if (
    typeof artifact.workflow_run.head_sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(artifact.workflow_run.head_sha) ||
    artifact.workflow_run.head_sha.toLowerCase() !== commit
  ) {
    throw new Error(
      `UE artifact ${artifact.id} ('${expectedName}') is not bound to commit ${commit}.`,
    )
  }

  return artifact
}

export function validateReleaseCandidate({ artifacts, commit, jobs, repository, run }) {
  validateRunMetadata(run, repository, commit)

  const trustedJobNames = new Set(RELEASE_VARIANTS.map((variant) => variant.jobName))
  const candidateTrustedJobs = jobs.filter((job) =>
    typeof job.name === 'string' && /^UE 5\.[0-9]+ BuildPlugin and automation/u.test(job.name),
  )
  if (
    candidateTrustedJobs.length !== RELEASE_VARIANTS.length ||
    candidateTrustedJobs.some((job) => !trustedJobNames.has(job.name))
  ) {
    throw new Error(
      `UE workflow run ${run.id} must expose exactly the three closed release-variant jobs.`,
    )
  }

  const expectedPackageNames = new Set(
    RELEASE_VARIANTS.map((variant) => variant.packageArtifactName),
  )
  const packageArtifacts = artifacts.filter((artifact) =>
    typeof artifact.name === 'string' &&
    artifact.name.startsWith('UnrealEditorWebUI-Package-'),
  )
  if (
    packageArtifacts.length !== RELEASE_VARIANTS.length ||
    packageArtifacts.some((artifact) => !expectedPackageNames.has(artifact.name))
  ) {
    throw new Error(
      `UE workflow run ${run.id} must expose exactly the three closed package artifacts.`,
    )
  }

  const expectedEnvironmentNames = new Set(
    RELEASE_VARIANTS.map((variant) => variant.buildEnvironmentArtifactName),
  )
  const environmentArtifacts = artifacts.filter((artifact) =>
    typeof artifact.name === 'string' &&
    artifact.name.startsWith('UnrealEditorWebUI-BuildEnvironment-'),
  )
  if (
    environmentArtifacts.length !== RELEASE_VARIANTS.length ||
    environmentArtifacts.some((artifact) => !expectedEnvironmentNames.has(artifact.name))
  ) {
    throw new Error(
      `UE workflow run ${run.id} must expose exactly the three closed build-environment artifacts.`,
    )
  }

  const selections = RELEASE_VARIANTS.map((variant) => {
    const expectedJobs = jobs.filter((job) => job.name === variant.jobName)
    if (expectedJobs.length !== 1 || expectedJobs[0].conclusion !== 'success') {
      const conclusions = expectedJobs.map((job) => job.conclusion).join(', ') || 'missing'
      throw new Error(
        `UE workflow run ${run.id} does not contain exactly one successful '${variant.jobName}' job (found ${conclusions}).`,
      )
    }
    const job = expectedJobs[0]
    if (!Number.isSafeInteger(job.id) || job.id <= 0) {
      throw new Error(
        `UE workflow run ${run.id} job '${variant.jobName}' does not expose a safe positive id.`,
      )
    }
    if (
      job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      job.run_id !== run.id ||
      job.head_sha?.toLowerCase() !== commit ||
      job.workflow_name !== 'UE CI'
    ) {
      throw new Error(
        `UE job ${job.id} does not match the selected completed workflow run and commit.`,
      )
    }
    const jobLabels = new Set(
      (Array.isArray(job.labels) ? job.labels : [])
        .filter((label) => typeof label === 'string')
        .map((label) => label.toLowerCase()),
    )
    const missingLabels = variant.runnerLabels.filter((label) => !jobLabels.has(label))
    const closedEngineLabels = RELEASE_VARIANTS
      .map((candidate) => candidate.runnerLabel)
      .filter((label) => jobLabels.has(label))
    const hasNamedRunner =
      typeof job.runner_name === 'string' && job.runner_name.trim().length > 0
    if (
      missingLabels.length > 0 ||
      !hasNamedRunner ||
      closedEngineLabels.length !== 1 ||
      closedEngineLabels[0] !== variant.runnerLabel
    ) {
      throw new Error(
        `UE job ${job.id} was not assigned to the required trusted runner labels for ${variant.releaseVariant} (missing: ${missingLabels.join(', ') || 'none'}).`,
      )
    }

    const expectedArtifacts = artifacts.filter(
      (artifact) => artifact.name === variant.packageArtifactName,
    )
    if (expectedArtifacts.length !== 1) {
      throw new Error(
        `UE workflow run ${run.id} must contain exactly one '${variant.packageArtifactName}' artifact; found ${expectedArtifacts.length}.`,
      )
    }
    const expectedBuildEnvironmentArtifacts = artifacts.filter(
      (artifact) => artifact.name === variant.buildEnvironmentArtifactName,
    )
    if (expectedBuildEnvironmentArtifacts.length !== 1) {
      throw new Error(
        `UE workflow run ${run.id} must contain exactly one '${variant.buildEnvironmentArtifactName}' artifact; found ${expectedBuildEnvironmentArtifacts.length}.`,
      )
    }
    return {
      variant,
      job,
      artifact: validateBoundArtifact(
        expectedArtifacts[0],
        variant.packageArtifactName,
        run,
        commit,
      ),
      buildEnvironmentArtifact: validateBoundArtifact(
        expectedBuildEnvironmentArtifacts[0],
        variant.buildEnvironmentArtifactName,
        run,
        commit,
      ),
    }
  })

  if (new Set(selections.map((selection) => selection.job.id)).size !== selections.length) {
    throw new Error(`UE workflow run ${run.id} reused one job id across release variants.`)
  }
  const selectedArtifactIds = selections.flatMap((selection) => [
    selection.artifact.id,
    selection.buildEnvironmentArtifact.id,
  ])
  if (new Set(selectedArtifactIds).size !== selectedArtifactIds.length) {
    throw new Error(`UE workflow run ${run.id} reused one artifact id across release variants.`)
  }

  return { run, variants: selections }
}

export async function downloadVerifiedArtifactSet({
  directory,
  fetchImpl = fetch,
  repository,
  selection,
  token,
}) {
  if (!directory) throw new Error('A fresh artifact download directory is required.')
  const destination = resolve(directory)
  await assertPathDoesNotExist(destination)
  await mkdir(destination, { recursive: false })
  const results = []
  try {
    for (const selected of selection.variants) {
      const packageOutputPath = join(destination, `trusted-package-${selected.variant.id}.zip`)
      const buildEnvironmentOutputPath = join(
        destination,
        `trusted-build-environment-${selected.variant.id}.zip`,
      )
      const downloads = await downloadVerifiedArtifactPair({
        buildEnvironmentArtifactId: selected.buildEnvironmentArtifact.id,
        buildEnvironmentExpectedDigest: selected.buildEnvironmentArtifact.digest,
        buildEnvironmentOutputPath,
        fetchImpl,
        packageArtifactId: selected.artifact.id,
        packageExpectedDigest: selected.artifact.digest,
        packageOutputPath,
        repository,
        token,
      })
      results.push({ variant: selected.variant, ...downloads })
    }
    return results
  } catch (error) {
    try {
      await rm(destination, { force: true, recursive: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Artifact set verification failed and cleanup was incomplete.',
      )
    }
    throw error
  }
}

export async function validateRun(
  token,
  repository,
  commit,
  run,
  githubJsonImpl = githubJson,
) {
  validateRunMetadata(run, repository, commit)
  const repositoryApiPath = repositoryPath(repository)
  const jobs = await githubCollection(
    token,
    `/repos/${repositoryApiPath}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    'jobs',
    githubJsonImpl,
  )
  const artifacts = await githubCollection(
    token,
    `/repos/${repositoryApiPath}/actions/runs/${run.id}/artifacts`,
    'artifacts',
    githubJsonImpl,
  )

  return validateReleaseCandidate({ artifacts, commit, jobs, repository, run })
}

export function releaseCandidateOutputs(selection) {
  return [
    `ue_run_id=${selection.run.id}`,
    `ue_run_attempt=${selection.run.run_attempt}`,
    `ue_run_url=${selection.run.html_url}`,
    ...selection.variants.flatMap(({ artifact, buildEnvironmentArtifact, job, variant }) => [
      `${variant.id}_job_id=${job.id}`,
      `${variant.id}_artifact_id=${artifact.id}`,
      `${variant.id}_artifact_digest=${artifact.digest}`,
      `${variant.id}_artifact_name=${artifact.name}`,
      `${variant.id}_build_environment_artifact_id=${buildEnvironmentArtifact.id}`,
      `${variant.id}_build_environment_artifact_digest=${buildEnvironmentArtifact.digest}`,
      `${variant.id}_build_environment_artifact_name=${buildEnvironmentArtifact.name}`,
    ]),
  ]
}

function writeOutputs(selection) {
  const outputs = releaseCandidateOutputs(selection)

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`, 'utf8')
  }

  console.log(
    JSON.stringify(
      {
        commit: selection.run.head_sha,
        runId: selection.run.id,
        runAttempt: selection.run.run_attempt,
        runUrl: selection.run.html_url,
        variants: selection.variants.map(
          ({ artifact, buildEnvironmentArtifact, job, variant }) => ({
            releaseVariant: variant.releaseVariant,
            jobId: job.id,
            artifactId: artifact.id,
            artifactDigest: artifact.digest,
            artifactName: artifact.name,
            buildEnvironmentArtifactDigest: buildEnvironmentArtifact.digest,
            buildEnvironmentArtifactId: buildEnvironmentArtifact.id,
            buildEnvironmentArtifactName: buildEnvironmentArtifact.name,
          }),
        ),
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
  const downloadDirectory = argumentsMap.get('download-directory') ?? ''
  const token = process.env.GITHUB_TOKEN ?? ''

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid release commit '${commit}'. Expected a full 40-character Git SHA.`)
  }
  if (requestedRunId && !/^[1-9][0-9]*$/.test(requestedRunId)) {
    throw new Error(`Invalid workflow run id '${requestedRunId}'.`)
  }
  if (!downloadDirectory) {
    throw new Error('--download-directory is required for the closed six-artifact set.')
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to verify UE workflow metadata and artifacts.')
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
      selection = await validateRun(token, repository, commit, run)
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

  const downloads = await downloadVerifiedArtifactSet({
    directory: downloadDirectory,
    repository,
    selection,
    token,
  })
  for (const download of downloads) {
    console.log(
      `Verified ${download.variant.releaseVariant}: ${download.package.sizeInBytes} package bytes and ${download.buildEnvironment.sizeInBytes} build-environment bytes.`,
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
