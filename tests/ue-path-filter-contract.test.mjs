import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parse } from 'yaml'

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

function quotedValues(source) {
  return [...source.matchAll(/"([^"]+)"/gu)].map((match) => match[1])
}

test('UE pushes cover every direct workflow and packaging input', () => {
  const workflow = parse(readRepositoryFile('.github/workflows/ue-ci.yml'))
  const push = workflow.on.push

  assert.deepEqual(push.branches, ['main'])
  assert.deepEqual(push.paths, EXPECTED_PUSH_PATHS)
  assert.equal(Object.hasOwn(push, 'paths-ignore'), false)

  const powershell = readRepositoryFile('scripts/package-plugin.ps1')
  const powershellDirectories = /\$pluginDirectories = @\(([^)]+)\)/u.exec(powershell)
  assert.ok(powershellDirectories, 'PowerShell package directory inventory is missing')

  const bash = readRepositoryFile('scripts/package-plugin.sh')
  const bashDirectories = /^for directory_name in ([^;]+); do$/mu.exec(bash)
  assert.ok(bashDirectories, 'Bash package directory inventory is missing')

  assert.deepEqual(quotedValues(powershellDirectories[1]), EXPECTED_PACKAGE_DIRECTORIES)
  assert.deepEqual(bashDirectories[1].trim().split(/\s+/u), EXPECTED_PACKAGE_DIRECTORIES)
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
  const job = workflow.jobs['buildplugin-and-automation']
  const trustedDispatch = workflow.on.workflow_dispatch.inputs.run_trusted_ue_validation

  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch'])
  assert.equal(trustedDispatch.required, true)
  assert.equal(trustedDispatch.default, false)
  assert.equal(trustedDispatch.type, 'boolean')
  assert.deepEqual(job.environment, { name: 'ue-self-hosted' })
  assert.deepEqual(job['runs-on'], [
    'self-hosted',
    'windows',
    'gui',
    "${{ github.event_name == 'workflow_dispatch' && inputs.ue_version == '5.3' && 'ue-5.3' || 'ue-5.8' }}",
  ])
  assert.equal(job.if, EXPECTED_TRUSTED_JOB_CONDITION)
})
