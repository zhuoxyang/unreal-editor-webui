import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_ARTIFACT_NAME,
  EXPECTED_JOB_NAME,
  EXPECTED_RUNNER_LABELS,
  githubCollection,
  validateReleaseCandidate,
} from '../scripts/resolve-ue-release-artifact.mjs'

const commit = '1'.repeat(40)
const repository = 'owner/repository'

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
    status: 'completed',
  }
  return {
    artifacts: [{
      digest: `sha256:${'a'.repeat(64)}`,
      expired: false,
      id: 303,
      name: EXPECTED_ARTIFACT_NAME,
      size_in_bytes: 1024,
      workflow_run: { head_sha: commit, id: run.id },
    }],
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

const rejectionCases = [
  ['wrong workflow', (value) => { value.run.path = '.github/workflows/ci.yml' }, /workflow path/],
  ['wrong commit', (value) => { value.run.head_sha = '2'.repeat(40) }, /head SHA/],
  ['failed run', (value) => { value.run.conclusion = 'failure' }, /run state/],
  ['untrusted event', (value) => { value.run.event = 'pull_request' }, /not trusted/],
  ['non-main push', (value) => { value.run.head_branch = 'feature' }, /expected main/],
  ['fork repository', (value) => { value.run.head_repository.full_name = 'fork/repository' }, /head repository/],
  ['UE 5.5 job', (value) => { value.jobs[0].name = 'UE 5.5 BuildPlugin and automation' }, /exactly one successful/],
  ['missing GUI label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'gui') }, /missing: gui/],
  ['missing UE 5.8 label', (value) => { value.jobs[0].labels = value.jobs[0].labels.filter((label) => label !== 'ue-5.8') }, /missing: ue-5.8/],
  ['unnamed runner', (value) => { value.jobs[0].runner_name = '' }, /required trusted runner labels/],
  ['UE 5.5 artifact', (value) => { value.artifacts[0].name = 'UnrealEditorWebUI-Package-UE55' }, /exactly one/],
  ['duplicate artifact', (value) => { value.artifacts.push({ ...value.artifacts[0], id: 304 }) }, /found 2/],
  ['expired artifact', (value) => { value.artifacts[0].expired = true }, /has expired/],
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
]

for (const [name, mutate, expected] of rejectionCases) {
  test(`rejects ${name}`, () => {
    const candidate = eligibleCandidate()
    mutate(candidate)
    assert.throws(() => validateReleaseCandidate(candidate), expected)
  })
}
