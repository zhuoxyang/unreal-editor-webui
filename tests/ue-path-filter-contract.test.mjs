import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parse } from 'yaml'
import {
  EXACT_COMMIT_INPUT_PATHS,
  PLUGIN_DIRECTORIES,
} from '../scripts/stage-plugin-from-commit.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_PUSH_PATHS = [
  '.github/workflows/ue-ci.yml',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  'Config/**',
  'Content/**',
  'Platforms/**',
  'Python/**',
  'Resources/**',
  'Shaders/**',
  'Source/**',
  'Web/**',
  'frontend/**',
  'rez/**',
  'scripts/**',
  'tests/**',
  'LICENSE',
  'UnrealEditorWebUI.uplugin',
]
const EXPECTED_PACKAGE_DIRECTORIES = [
  'Config',
  'Content',
  'Platforms',
  'Python',
  'Resources',
  'Shaders',
  'Source',
  'Web',
]
const EXPECTED_TRUSTED_JOB_CONDITION =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && inputs.run_trusted_ue_validation)"

function readRepositoryFile(path) {
  return readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
}

function pushPathCoversInput(pushPath, inputPath) {
  if (!pushPath.endsWith('/**')) return pushPath === inputPath
  const directory = pushPath.slice(0, -3)
  return inputPath === directory || inputPath.startsWith(`${directory}/`)
}

test('UE pushes cover every direct workflow and packaging input', () => {
  const workflow = parse(readRepositoryFile('.github/workflows/ue-ci.yml'))
  const push = workflow.on.push

  assert.deepEqual(push.branches, ['main'])
  assert.deepEqual(push.paths, EXPECTED_PUSH_PATHS)
  assert.equal(Object.hasOwn(push, 'paths-ignore'), false)

  const powershell = readRepositoryFile('scripts/package-plugin.ps1')
  const bash = readRepositoryFile('scripts/package-plugin.sh')
  assert.match(powershell, /stage-plugin-from-commit\.mjs/u)
  assert.match(powershell, /\$SourceCommit/u)
  assert.match(bash, /stage-plugin-from-commit\.mjs/u)
  assert.match(bash, /\$SOURCE_COMMIT/u)
  assert.deepEqual(PLUGIN_DIRECTORIES, EXPECTED_PACKAGE_DIRECTORIES)
  for (const inputPath of EXACT_COMMIT_INPUT_PATHS) {
    assert.ok(
      push.paths.some((pushPath) => pushPathCoversInput(pushPath, inputPath)),
      `${inputPath} is an exact-commit input missing from push.paths`,
    )
  }
  for (const directory of EXPECTED_PACKAGE_DIRECTORIES) {
    assert.ok(push.paths.includes(`${directory}/**`), `${directory} is missing from push.paths`)
  }
})

test('documentation-only changes stay outside the licensed UE trigger', () => {
  const workflow = parse(readRepositoryFile('.github/workflows/ue-ci.yml'))
  const paths = workflow.on.push.paths

  assert.equal(paths.some((path) => path === 'README.md' || path.startsWith('docs/')), false)
})

test('the protected self-hosted trust boundary stays unchanged', () => {
  const workflow = parse(readRepositoryFile('.github/workflows/ue-ci.yml'))
  const trustedDispatch = workflow.on.workflow_dispatch.inputs.run_trusted_ue_validation

  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch'])
  assert.equal(trustedDispatch.required, true)
  assert.equal(trustedDispatch.default, false)
  assert.equal(trustedDispatch.type, 'boolean')
  for (const jobName of ['buildplugin-and-automation', 'rez-external-e2e']) {
    const job = workflow.jobs[jobName]
    assert.deepEqual(job.environment, { name: 'ue-self-hosted' })
    assert.deepEqual(job['runs-on'], [
      'self-hosted',
      'windows',
      'gui',
      '${{ matrix.runner_label }}',
    ])
    assert.equal(job.strategy['max-parallel'], 1)
    assert.equal(
      job.strategy.matrix,
      '${{ fromJSON(needs.ue-config-validation.outputs.release_matrix) }}',
    )
    assert.equal(job.if, EXPECTED_TRUSTED_JOB_CONDITION)
  }
})
