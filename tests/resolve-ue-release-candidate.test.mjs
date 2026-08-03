import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_ARTIFACT_NAME,
  EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME,
  EXPECTED_JOB_NAME,
  EXPECTED_RUNNER_LABELS,
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
  return {
    artifacts: [
      {
        digest: `sha256:${'a'.repeat(64)}`,
        expired: false,
        id: 303,
        name: EXPECTED_ARTIFACT_NAME,
        size_in_bytes: 1024,
        workflow_run: { head_sha: commit, id: run.id },
      },
      {
        digest: `sha256:${'c'.repeat(64)}`,
        expired: false,
        id: 305,
        name: EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME,
        size_in_bytes: 2048,
        workflow_run: { head_sha: commit, id: run.id },
      },
    ],
    commit,
    jobs: [{
      conclusion: 'success',
      id: 202,
      labels: [...EXPECTED_RUNNER_LABELS],
      name: EXPECTED_JOB_NAME,
      runner_name: 'trusted-ue58-gui',
    }],
    repository,
    run,
  }
}

test('accepts the exact successful UE 5.8 GUI candidate', () => {
  const candidate = eligibleCandidate()
  const selected = validateReleaseCandidate(candidate)

  assert.equal(selected.run.id, candidate.run.id)
  assert.equal(selected.job.name, EXPECTED_JOB_NAME)
  assert.equal(selected.artifact.name, EXPECTED_ARTIFACT_NAME)
  assert.equal(
    selected.buildEnvironmentArtifact.name,
    EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME,
  )
})

test('ignores the diagnostic artifact when selecting the exact UE 5.8 package', () => {
  const candidate = eligibleCandidate()
  candidate.artifacts.unshift({
    digest: `sha256:${'b'.repeat(64)}`,
    expired: false,
    id: 304,
    name: 'unreal-editor-webui-ue-logs',
    size_in_bytes: 2048,
    workflow_run: { head_sha: commit, id: candidate.run.id },
  })

  const selected = validateReleaseCandidate(candidate)
  assert.equal(selected.artifact.id, 303)
  assert.equal(selected.artifact.name, EXPECTED_ARTIFACT_NAME)
  assert.equal(selected.buildEnvironmentArtifact.id, 305)
})

test('preserves package outputs and exports run-attempt build-environment identity', () => {
  const selected = validateReleaseCandidate(eligibleCandidate())

  assert.deepEqual(releaseCandidateOutputs(selected), [
    'ue_run_id=101',
    'ue_run_attempt=3',
    'ue_run_url=https://github.example/run/101',
    'ue_job_id=202',
    'ue_artifact_id=303',
    `ue_artifact_digest=sha256:${'a'.repeat(64)}`,
    `ue_artifact_name=${EXPECTED_ARTIFACT_NAME}`,
    'ue_build_environment_artifact_id=305',
    `ue_build_environment_artifact_digest=sha256:${'c'.repeat(64)}`,
    `ue_build_environment_artifact_name=${EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME}`,
  ])
})

test('matches trusted runner labels using GitHub case-insensitive semantics', () => {
  const candidate = eligibleCandidate()
  candidate.jobs[0].labels = ['SELF-HOSTED', 'Windows', 'GUI', 'UE-5.8']

  const selected = validateReleaseCandidate(candidate)
  assert.equal(selected.job.id, candidate.jobs[0].id)
})

test('reads every GitHub API page before validating a collection', async () => {
  const requestedPaths = []
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
  const result = await githubCollection(
    'token',
    '/repos/owner/repository/actions/runs/101/jobs?filter=all',
    'jobs',
    async (_token, path) => {
      requestedPaths.push(path)
      return { jobs: path.endsWith('page=1') ? firstPage : [{ id: 101 }] }
    },
  )

  assert.equal(result.length, 101)
  assert.deepEqual(requestedPaths, [
    '/repos/owner/repository/actions/runs/101/jobs?filter=all&per_page=100&page=1',
    '/repos/owner/repository/actions/runs/101/jobs?filter=all&per_page=100&page=2',
  ])
})

test('reads jobs only from the selected workflow run attempt', async () => {
  const candidate = eligibleCandidate()
  const requestedPaths = []
  const selected = await validateRun(
    'token',
    repository,
    commit,
    candidate.run,
    async (_token, path) => {
      requestedPaths.push(path)
      if (path.includes('/jobs?')) {
        return { jobs: candidate.jobs }
      }
      return { artifacts: candidate.artifacts }
    },
  )

  assert.equal(selected.run.run_attempt, 3)
  assert.deepEqual(requestedPaths, [
    '/repos/owner/repository/actions/runs/101/attempts/3/jobs?per_page=100&page=1',
    '/repos/owner/repository/actions/runs/101/artifacts?per_page=100&page=1',
  ])
})

test('schema 2 provenance keeps package keys and names build-environment artifact keys consistently', () => {
  assert.match(releaseWorkflow, /"schemaVersion": 2/u)
  assert.match(releaseWorkflow, /"artifactId": int\(os\.environ\["UE_ARTIFACT_ID"\]\)/u)
  assert.match(releaseWorkflow, /"artifactName": os\.environ\["UE_ARTIFACT_NAME"\]/u)
  assert.match(releaseWorkflow, /"artifactDigest": os\.environ\["UE_ARTIFACT_DIGEST"\]/u)
  for (const key of ['artifactId', 'artifactName', 'artifactDigest']) {
    assert.match(
      releaseWorkflow,
      new RegExp(`"buildEnvironmentArtifact"[\\s\\S]*?"${key}"`, 'u'),
    )
  }
  assert.match(releaseWorkflow, /"buildEnvironment": build_environment/u)
  assert.match(releaseWorkflow, /"buildEnvironmentSha256"/u)
  assert.match(
    releaseWorkflow,
    /persisted\["ueValidation"\]\["buildEnvironment"\] != build_environment/u,
  )

  for (const schemaOneKey of [
    'releaseKind',
    'publishedAsGitHubRelease',
    'repository',
    'releaseTag',
    'releaseCommit',
    'generatedAt',
    'sourceArchiveCreated',
    'license',
    'ueValidation',
    'validationClaim',
  ]) {
    assert.match(releaseWorkflow, new RegExp(`"${schemaOneKey}"`, 'u'))
  }
})

test('release workflow safely extracts and verifies evidence before extracting the package', () => {
  const environmentExtraction = [
    'python scripts/extract-verified-artifact.py',
    '--archive "$BUILD_ENVIRONMENT_ARCHIVE"',
    '--destination trusted-build-environment',
    '--profile build-environment',
  ]
  const packageExtraction = [
    'python scripts/extract-verified-artifact.py',
    '--archive trusted-package.zip',
    '--destination trusted-package',
    '--profile package',
  ]

  let previousIndex = -1
  for (const fragment of environmentExtraction) {
    const index = releaseWorkflow.indexOf(fragment, previousIndex + 1)
    assert.ok(index > previousIndex, `missing or unordered environment extraction fragment: ${fragment}`)
    previousIndex = index
  }
  const verifyIndex = releaseWorkflow.indexOf('node scripts/ue-build-environment.mjs verify')
  assert.ok(verifyIndex > previousIndex, 'canonical evidence verification must follow safe extraction')
  previousIndex = verifyIndex
  for (const fragment of packageExtraction) {
    const index = releaseWorkflow.indexOf(fragment, previousIndex + 1)
    assert.ok(index > previousIndex, `missing or unordered package extraction fragment: ${fragment}`)
    previousIndex = index
  }
  const symlinkCheckIndex = releaseWorkflow.indexOf(
    'find trusted-package -type l -print -quit',
    previousIndex + 1,
  )
  const packageReadIndex = releaseWorkflow.indexOf(
    'test -f trusted-package/UnrealEditorWebUI.uplugin',
    previousIndex + 1,
  )
  assert.ok(symlinkCheckIndex > previousIndex, 'the package symlink defense must follow extraction')
  assert.ok(packageReadIndex > symlinkCheckIndex, 'package files must not be read before link checks')
  assert.doesNotMatch(releaseWorkflow, /\bunzip\b|python - <<'PY'/u)
})

const rejectionCases = [
  ['unsafe run id', (value) => { value.run.id = '101' }, /run id/],
  ['missing run attempt', (value) => { delete value.run.run_attempt }, /run attempt/],
  ['zero run attempt', (value) => { value.run.run_attempt = 0 }, /run attempt/],
  ['string run attempt', (value) => { value.run.run_attempt = '3' }, /run attempt/],
  ['unsafe run attempt', (value) => { value.run.run_attempt = Number.MAX_SAFE_INTEGER + 1 }, /run attempt/],
  ['wrong workflow', (value) => { value.run.path = '.github/workflows/ci.yml' }, /workflow path/],
  ['wrong commit', (value) => { value.run.head_sha = '2'.repeat(40) }, /head SHA/],
  ['failed run', (value) => { value.run.conclusion = 'failure' }, /run state/],
  ['untrusted event', (value) => { value.run.event = 'pull_request' }, /not trusted/],
  ['non-main push', (value) => { value.run.head_branch = 'feature' }, /expected main/],
  ['fork repository', (value) => { value.run.head_repository.full_name = 'fork/repository' }, /head repository/],
  ['UE 5.5 job', (value) => { value.jobs[0].name = 'UE 5.5 BuildPlugin and automation' }, /exactly one successful/],
  ['missing job id', (value) => { delete value.jobs[0].id }, /safe positive id/],
  ['string job id', (value) => { value.jobs[0].id = '202' }, /safe positive id/],
  ['zero job id', (value) => { value.jobs[0].id = 0 }, /safe positive id/],
  ['unsafe job id', (value) => { value.jobs[0].id = Number.MAX_SAFE_INTEGER + 1 }, /safe positive id/],
  ['missing GUI label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'gui') }, /missing: gui/],
  ['missing UE 5.8 label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'ue-5.8') }, /missing: ue-5.8/],
  ['unnamed runner', (value) => { value.jobs[0].runner_name = '' }, /required trusted runner labels/],
  ['non-string runner', (value) => { value.jobs[0].runner_name = 123 }, /required trusted runner labels/],
  ['blank runner', (value) => { value.jobs[0].runner_name = '   ' }, /required trusted runner labels/],
  ['UE 5.5 artifact', (value) => { value.artifacts[0].name = 'UnrealEditorWebUI-Package-UE55' }, /exactly one/],
  ['duplicate artifact', (value) => { value.artifacts.push({ ...value.artifacts[0], id: 304 }) }, /found 2/],
  ['expired artifact', (value) => { value.artifacts[0].expired = true }, /expired/],
  ['missing artifact expiry state', (value) => { delete value.artifacts[0].expired }, /non-expired state/],
  ['empty artifact', (value) => { value.artifacts[0].size_in_bytes = 0 }, /is empty/],
  ['invalid digest', (value) => { value.artifacts[0].digest = 'sha256:invalid' }, /valid immutable SHA-256/],
  ['missing artifact workflow-run binding', (value) => { delete value.artifacts[0].workflow_run }, /does not expose its workflow-run binding/],
  ['null artifact workflow-run binding', (value) => { value.artifacts[0].workflow_run = null }, /does not expose its workflow-run binding/],
  ['missing artifact run ID', (value) => { delete value.artifacts[0].workflow_run.id }, /not bound to workflow run/],
  ['string artifact run ID', (value) => { value.artifacts[0].workflow_run.id = `${value.run.id}` }, /not bound to workflow run/],
  ['wrong artifact run', (value) => { value.artifacts[0].workflow_run.id = 999 }, /not bound to workflow run/],
  ['missing artifact commit', (value) => { delete value.artifacts[0].workflow_run.head_sha }, /not bound to commit/],
  ['short artifact commit', (value) => { value.artifacts[0].workflow_run.head_sha = '1'.repeat(39) }, /not bound to commit/],
  ['wrong artifact commit', (value) => { value.artifacts[0].workflow_run.head_sha = '3'.repeat(40) }, /not bound to commit/],
  ['missing build environment artifact', (value) => {
    value.artifacts = value.artifacts.filter(
      ({ name }) => name !== EXPECTED_BUILD_ENVIRONMENT_ARTIFACT_NAME,
    )
  }, /BuildEnvironment-UE58.*found 0/],
  ['duplicate build environment artifact', (value) => {
    value.artifacts.push({ ...value.artifacts[1], id: 306 })
  }, /BuildEnvironment-UE58.*found 2/],
  ['expired build environment artifact', (value) => {
    value.artifacts[1].expired = true
  }, /BuildEnvironment-UE58.*expired/],
  ['missing build environment expiry state', (value) => {
    delete value.artifacts[1].expired
  }, /BuildEnvironment-UE58.*non-expired state/],
  ['empty build environment artifact', (value) => {
    value.artifacts[1].size_in_bytes = 0
  }, /BuildEnvironment-UE58.*is empty/],
  ['invalid build environment digest', (value) => {
    value.artifacts[1].digest = 'sha256:invalid'
  }, /BuildEnvironment-UE58.*valid immutable SHA-256/],
  ['wrong build environment run', (value) => {
    value.artifacts[1].workflow_run.id = 999
  }, /BuildEnvironment-UE58.*not bound to workflow run/],
  ['wrong build environment commit', (value) => {
    value.artifacts[1].workflow_run.head_sha = '4'.repeat(40)
  }, /BuildEnvironment-UE58.*not bound to commit/],
]

for (const [name, mutate, expected] of rejectionCases) {
  test(`rejects ${name}`, () => {
    const candidate = eligibleCandidate()
    mutate(candidate)
    assert.throws(() => validateReleaseCandidate(candidate), expected)
  })
}
