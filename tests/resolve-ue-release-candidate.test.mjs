import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_RELEASE_VARIANTS,
  githubCollection,
  releaseCandidateOutputs,
  validateReleaseCandidate,
  validateRun,
} from '../scripts/resolve-ue-release-artifact.mjs'

const commit = '1'.repeat(40)
const repository = 'owner/repository'
const releaseWorkflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/release-candidate.yml', import.meta.url)),
  'utf8',
)

function eligibleCandidate() {
  const run = {
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_repository: { full_name: repository },
    head_sha: commit,
    html_url: 'https://github.example/run/101',
    id: 101,
    path: '.github/workflows/ue-ci.yml',
    run_attempt: 3,
    status: 'completed',
  }
  let artifactId = 300
  let jobId = 200
  return {
    artifacts: EXPECTED_RELEASE_VARIANTS.flatMap((variant, index) => [
      {
        digest: `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
        expired: false,
        id: artifactId++,
        name: variant.packageArtifactName,
        size_in_bytes: 1024,
        workflow_run: { head_sha: commit, id: run.id },
      },
      {
        digest: `sha256:${String.fromCharCode(100 + index).repeat(64)}`,
        expired: false,
        id: artifactId++,
        name: variant.buildEnvironmentArtifactName,
        size_in_bytes: 2048,
        workflow_run: { head_sha: commit, id: run.id },
      },
    ]),
    commit,
    jobs: EXPECTED_RELEASE_VARIANTS.map((variant) => ({
      conclusion: 'success',
      head_sha: commit,
      id: jobId++,
      labels: [...variant.runnerLabels],
      name: variant.jobName,
      run_id: run.id,
      runner_name: `trusted-${variant.id}-gui`,
      status: 'completed',
      workflow_name: 'UE CI',
    })),
    repository,
    run,
  }
}

test('accepts exactly one successful UE54, UE55, and UE58 selection from one attempt', () => {
  const selected = validateReleaseCandidate(eligibleCandidate())
  assert.equal(selected.run.id, 101)
  assert.deepEqual(
    selected.variants.map(({ variant }) => variant.id),
    ['ue54', 'ue55', 'ue58'],
  )
  assert.deepEqual(
    selected.variants.map(({ artifact }) => artifact.name),
    EXPECTED_RELEASE_VARIANTS.map(({ packageArtifactName }) => packageArtifactName),
  )
})

test('ignores diagnostic artifacts outside the closed package namespaces', () => {
  const candidate = eligibleCandidate()
  candidate.artifacts.push({ name: 'unreal-editor-webui-ue-diagnostics-ue54' })
  assert.equal(validateReleaseCandidate(candidate).variants.length, 3)
})

test('exports shared run identity and a closed output group for every variant', () => {
  const outputs = releaseCandidateOutputs(validateReleaseCandidate(eligibleCandidate()))
  assert.deepEqual(outputs.slice(0, 3), [
    'ue_run_id=101',
    'ue_run_attempt=3',
    'ue_run_url=https://github.example/run/101',
  ])
  for (const variant of EXPECTED_RELEASE_VARIANTS) {
    for (const suffix of [
      'job_id',
      'artifact_id',
      'artifact_digest',
      'artifact_name',
      'build_environment_artifact_id',
      'build_environment_artifact_digest',
      'build_environment_artifact_name',
    ]) {
      assert.equal(outputs.some((line) => line.startsWith(`${variant.id}_${suffix}=`)), true)
    }
  }
})

test('matches trusted labels case-insensitively but rejects cross-variant labels', () => {
  const candidate = eligibleCandidate()
  candidate.jobs[0].labels = candidate.jobs[0].labels.map((value) => value.toUpperCase())
  assert.doesNotThrow(() => validateReleaseCandidate(candidate))
  candidate.jobs[0].labels.push('ue-5.5')
  assert.throws(() => validateReleaseCandidate(candidate), /required trusted runner labels/iu)
})

test('reads all pages and jobs only from the selected run attempt', async () => {
  const requestedPaths = []
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
  const paged = await githubCollection(
    'token',
    '/repos/owner/repository/actions/runs/101/jobs?filter=all',
    'jobs',
    async (_token, path) => {
      requestedPaths.push(path)
      return { jobs: path.endsWith('page=1') ? firstPage : [{ id: 101 }] }
    },
  )
  assert.equal(paged.length, 101)

  const candidate = eligibleCandidate()
  requestedPaths.length = 0
  await validateRun('token', repository, commit, candidate.run, async (_token, path) => {
    requestedPaths.push(path)
    return path.includes('/jobs?') ? { jobs: candidate.jobs } : { artifacts: candidate.artifacts }
  })
  assert.deepEqual(requestedPaths, [
    '/repos/owner/repository/actions/runs/101/attempts/3/jobs?per_page=100&page=1',
    '/repos/owner/repository/actions/runs/101/artifacts?per_page=100&page=1',
  ])
})

const rejectionCases = [
  ['unsafe run id', (value) => { value.run.id = '101' }, /run id/],
  ['missing run attempt', (value) => { delete value.run.run_attempt }, /run attempt/],
  ['zero run attempt', (value) => { value.run.run_attempt = 0 }, /run attempt/],
  ['string run attempt', (value) => { value.run.run_attempt = '3' }, /run attempt/],
  ['unsafe run attempt', (value) => { value.run.run_attempt = Number.MAX_SAFE_INTEGER + 1 }, /run attempt/],
  ['wrong workflow', (value) => { value.run.path = '.github/workflows/ci.yml' }, /workflow path/],
  ['untrusted event', (value) => { value.run.event = 'pull_request' }, /not trusted/],
  ['non-main push', (value) => { value.run.head_branch = 'feature' }, /expected main/],
  ['non-main workflow dispatch', (value) => { value.run.event = 'workflow_dispatch'; value.run.head_branch = 'feature' }, /expected main/],
  ['wrong commit', (value) => { value.run.head_sha = '2'.repeat(40) }, /head SHA/],
  ['wrong repository', (value) => { value.run.head_repository.full_name = 'fork/repository' }, /head repository/],
  ['failed run', (value) => { value.run.conclusion = 'failure' }, /run state/],
  ['missing UE55 job', (value) => { value.jobs.splice(1, 1) }, /exactly the three/],
  ['duplicate UE55 job', (value) => { value.jobs.push({ ...value.jobs[1], id: 999 }) }, /exactly the three/],
  ['unknown UE job', (value) => { value.jobs[1].name = 'UE 5.7 BuildPlugin and automation' }, /exactly the three/],
  ['wrong job run', (value) => { value.jobs[0].run_id = 999 }, /selected completed workflow run/],
  ['missing job run', (value) => { delete value.jobs[0].run_id }, /selected completed workflow run/],
  ['string job run', (value) => { value.jobs[0].run_id = `${value.run.id}` }, /selected completed workflow run/],
  ['wrong job SHA', (value) => { value.jobs[0].head_sha = '2'.repeat(40) }, /selected completed workflow run/],
  ['missing job SHA', (value) => { delete value.jobs[0].head_sha }, /selected completed workflow run/],
  ['short job SHA', (value) => { value.jobs[0].head_sha = '1'.repeat(39) }, /selected completed workflow run/],
  ['wrong workflow name', (value) => { value.jobs[0].workflow_name = 'Other' }, /selected completed workflow run/],
  ['missing workflow name', (value) => { delete value.jobs[0].workflow_name }, /selected completed workflow run/],
  ['incomplete job status', (value) => { value.jobs[0].status = 'in_progress' }, /selected completed workflow run/],
  ['failed exact job', (value) => { value.jobs[0].conclusion = 'failure' }, /exactly one successful/],
  ['missing job id', (value) => { delete value.jobs[0].id }, /safe positive id/],
  ['string job id', (value) => { value.jobs[0].id = '200' }, /safe positive id/],
  ['zero job id', (value) => { value.jobs[0].id = 0 }, /safe positive id/],
  ['unsafe job id', (value) => { value.jobs[0].id = Number.MAX_SAFE_INTEGER + 1 }, /safe positive id/],
  ['reused job id', (value) => { value.jobs[1].id = value.jobs[0].id }, /reused one job id/],
  ['missing GUI label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'gui') }, /required trusted runner labels/],
  ['missing exact UE label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'ue-5.4') }, /required trusted runner labels/],
  ['malformed labels', (value) => { value.jobs[0].labels = null }, /required trusted runner labels/],
  ['missing runner', (value) => { delete value.jobs[0].runner_name }, /required trusted runner labels/],
  ['unnamed runner', (value) => { value.jobs[0].runner_name = '' }, /required trusted runner labels/],
  ['non-string runner', (value) => { value.jobs[0].runner_name = 123 }, /required trusted runner labels/],
  ['blank runner', (value) => { value.jobs[0].runner_name = '   ' }, /required trusted runner labels/],
  ['missing package', (value) => { value.artifacts.splice(0, 1) }, /three closed package/],
  ['duplicate package', (value) => { value.artifacts.push({ ...value.artifacts[0], id: 999 }) }, /three closed package/],
  ['cross-version package', (value) => { value.artifacts[0].name = 'UnrealEditorWebUI-Package-UE57-Win64' }, /three closed package/],
  ['missing environment', (value) => { value.artifacts.splice(1, 1) }, /three closed build-environment/],
  ['duplicate environment', (value) => { value.artifacts.push({ ...value.artifacts[1], id: 999 }) }, /three closed build-environment/],
  ['expired package', (value) => { value.artifacts[0].expired = true }, /expired/],
  ['missing package expiry state', (value) => { delete value.artifacts[0].expired }, /non-expired state/],
  ['empty package', (value) => { value.artifacts[0].size_in_bytes = 0 }, /empty/],
  ['missing package size', (value) => { delete value.artifacts[0].size_in_bytes }, /empty/],
  ['bad package digest', (value) => { value.artifacts[0].digest = 'sha256:bad' }, /SHA-256/],
  ['missing package id', (value) => { delete value.artifacts[0].id }, /safe positive id/],
  ['string package id', (value) => { value.artifacts[0].id = '300' }, /safe positive id/],
  ['zero package id', (value) => { value.artifacts[0].id = 0 }, /safe positive id/],
  ['unsafe package id', (value) => { value.artifacts[0].id = Number.MAX_SAFE_INTEGER + 1 }, /safe positive id/],
  ['missing package workflow-run binding', (value) => { delete value.artifacts[0].workflow_run }, /workflow-run binding/],
  ['null package workflow-run binding', (value) => { value.artifacts[0].workflow_run = null }, /workflow-run binding/],
  ['missing artifact run ID', (value) => { delete value.artifacts[0].workflow_run.id }, /not bound to workflow run/],
  ['string artifact run ID', (value) => { value.artifacts[0].workflow_run.id = `${value.run.id}` }, /not bound to workflow run/],
  ['zero artifact run ID', (value) => { value.artifacts[0].workflow_run.id = 0 }, /not bound to workflow run/],
  ['wrong artifact run', (value) => { value.artifacts[0].workflow_run.id = 999 }, /not bound to workflow run/],
  ['missing artifact commit', (value) => { delete value.artifacts[0].workflow_run.head_sha }, /not bound to commit/],
  ['short artifact commit', (value) => { value.artifacts[0].workflow_run.head_sha = '1'.repeat(39) }, /not bound to commit/],
  ['wrong artifact commit', (value) => { value.artifacts[0].workflow_run.head_sha = '3'.repeat(40) }, /not bound to commit/],
  ['missing environment id', (value) => { delete value.artifacts[1].id }, /safe positive id/],
  ['string environment id', (value) => { value.artifacts[1].id = '301' }, /safe positive id/],
  ['zero environment id', (value) => { value.artifacts[1].id = 0 }, /safe positive id/],
  ['unsafe environment id', (value) => { value.artifacts[1].id = Number.MAX_SAFE_INTEGER + 1 }, /safe positive id/],
  ['expired environment', (value) => { value.artifacts[1].expired = true }, /expired/],
  ['missing environment expiry state', (value) => { delete value.artifacts[1].expired }, /non-expired state/],
  ['empty environment', (value) => { value.artifacts[1].size_in_bytes = 0 }, /empty/],
  ['missing environment size', (value) => { delete value.artifacts[1].size_in_bytes }, /empty/],
  ['bad environment digest', (value) => { value.artifacts[1].digest = 'sha256:bad' }, /SHA-256/],
  ['missing environment digest', (value) => { delete value.artifacts[1].digest }, /SHA-256/],
  ['missing environment workflow-run binding', (value) => { delete value.artifacts[1].workflow_run }, /workflow-run binding/],
  ['null environment workflow-run binding', (value) => { value.artifacts[1].workflow_run = null }, /workflow-run binding/],
  ['missing environment run ID', (value) => { delete value.artifacts[1].workflow_run.id }, /not bound to workflow run/],
  ['string environment run ID', (value) => { value.artifacts[1].workflow_run.id = `${value.run.id}` }, /not bound to workflow run/],
  ['zero environment run ID', (value) => { value.artifacts[1].workflow_run.id = 0 }, /not bound to workflow run/],
  ['wrong environment run', (value) => { value.artifacts[1].workflow_run.id = 999 }, /not bound to workflow run/],
  ['missing environment commit', (value) => { delete value.artifacts[1].workflow_run.head_sha }, /not bound to commit/],
  ['short environment commit', (value) => { value.artifacts[1].workflow_run.head_sha = '1'.repeat(39) }, /not bound to commit/],
  ['wrong environment commit', (value) => { value.artifacts[1].workflow_run.head_sha = '4'.repeat(40) }, /not bound to commit/],
  ['reused artifact id', (value) => { value.artifacts[1].id = value.artifacts[0].id }, /reused one artifact id/],
]

for (const [name, mutate, expected] of rejectionCases) {
  test(`rejects ${name}`, () => {
    const candidate = eligibleCandidate()
    mutate(candidate)
    assert.throws(() => validateReleaseCandidate(candidate), expected)
  })
}

test('release workflow requires a real exact tag and verifies all environments before packages', () => {
  assert.match(releaseWorkflow, /git show-ref --verify --quiet "refs\/tags\/\$release_tag"/u)
  assert.match(releaseWorkflow, /refs\/tags\/\$release_tag\^\{commit\}/u)
  const environmentStep = releaseWorkflow.indexOf('Extract and verify all build environments')
  const environment54 = releaseWorkflow.indexOf('verify_environment ue54', environmentStep)
  const environment55 = releaseWorkflow.indexOf('verify_environment ue55', environment54)
  const environment58 = releaseWorkflow.indexOf('verify_environment ue58', environment55)
  const packageStep = releaseWorkflow.indexOf('Extract verified packages', environment58)
  assert.ok(environmentStep >= 0 && environment54 > environmentStep)
  assert.ok(environment55 > environment54 && environment58 > environment55)
  assert.ok(packageStep > environment58)
  assert.doesNotMatch(releaseWorkflow.slice(0, packageStep), /--profile package/u)
})

test('release workflow creates three native archives and provenance for the closed set', () => {
  assert.match(
    releaseWorkflow,
    /for spec in "ue54 UE54-Win64" "ue55 UE55-Win64" "ue58 UE58-Win64"/u,
  )
  assert.match(
    releaseWorkflow,
    /archive_name="UnrealEditorWebUI-\$\{RELEASE_TAG\}-\$\{release_variant\}\.zip"/u,
  )
  assert.match(
    releaseWorkflow,
    /local canonical="release\/metadata\/build-environment-\$release_variant\.json"/u,
  )
  for (const [variantId, releaseVariant] of [
    ['ue54', 'UE54-Win64'],
    ['ue55', 'UE55-Win64'],
    ['ue58', 'UE58-Win64'],
  ]) {
    assert.match(
      releaseWorkflow,
      new RegExp(`verify_environment ${variantId} ${releaseVariant}`, 'u'),
    )
  }
  assert.match(releaseWorkflow, /"schemaVersion": 3/u)
  assert.match(releaseWorkflow, /"variants": validations/u)
  assert.match(releaseWorkflow, /"buildEnvironmentSha256"/u)
  assert.match(releaseWorkflow, /"releaseArchive"/u)
  assert.match(releaseWorkflow, /Release archive SHA-256 sidecar is not canonical/u)
  assert.match(releaseWorkflow, /descriptor\.EngineVersion !== `\$\{variant\.engineAssociation\}\.0`/u)
  assert.match(releaseWorkflow, /descriptor\.Installed !== true/u)
  assert.ok(
    releaseWorkflow.indexOf('Create three candidate archives') <
      releaseWorkflow.indexOf('Write fail-closed three-variant provenance'),
  )
})

test('release workflow signs only the three final archives before candidate upload', () => {
  const permissions = releaseWorkflow.match(/permissions:\r?\n(?<body>(?:  [^\r\n]+\r?\n)+)\r?\nconcurrency:/u)
  assert.ok(permissions?.groups?.body)
  assert.deepEqual(
    permissions.groups.body
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .sort(),
    ['actions: read', 'attestations: write', 'contents: read', 'id-token: write'],
  )

  const archiveStep = releaseWorkflow.indexOf('Create three candidate archives')
  const provenanceStep = releaseWorkflow.indexOf('Write fail-closed three-variant provenance')
  const attestationStep = releaseWorkflow.indexOf('Attest three native release archives')
  const uploadStep = releaseWorkflow.indexOf('Upload release candidate bundle')
  assert.ok(
    archiveStep >= 0 &&
      provenanceStep > archiveStep &&
      attestationStep > provenanceStep &&
      uploadStep > attestationStep,
  )

  const attestationContract = releaseWorkflow.slice(attestationStep, uploadStep)
  assert.match(
    attestationContract,
    /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/u,
  )
  const subjectBlock = attestationContract.match(
    /subject-path: \|\r?\n(?<body>(?:[ \t]+[^\r\n]+\r?\n)+)/u,
  )
  assert.ok(subjectBlock?.groups?.body)
  assert.deepEqual(
    subjectBlock.groups.body
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim()),
    [
      '${{ github.workspace }}/release/UnrealEditorWebUI-${{ steps.release.outputs.release_tag }}-UE54-Win64.zip',
      '${{ github.workspace }}/release/UnrealEditorWebUI-${{ steps.release.outputs.release_tag }}-UE55-Win64.zip',
      '${{ github.workspace }}/release/UnrealEditorWebUI-${{ steps.release.outputs.release_tag }}-UE58-Win64.zip',
    ],
  )
  assert.doesNotMatch(
    attestationContract,
    /\.sha256|metadata|npm-cyclonedx|sbom-path|predicate-path|predicate-type|push-to-registry|\*\.zip/u,
  )
})
