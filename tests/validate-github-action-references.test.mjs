import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifyUsesReference,
  discoverWorkflowFiles,
  parseWorkflowUses,
  validateWorkflowActionReferences,
  WORKFLOW_VALIDATION_LIMITS,
} from '../scripts/validate-github-action-references.mjs'

const VALIDATOR_PATH = fileURLToPath(new URL('../scripts/validate-github-action-references.mjs', import.meta.url))
const LOWER_SHA = 'a'.repeat(40)
const UPPER_SHA = 'B'.repeat(40)

function errorCodes(result) {
  return result.errors.map((error) => error.code)
}

function assertRejectedSource(label, source, expectedCode) {
  const result = validateWorkflowActionReferences(source, `${label}.yml`)
  assert.ok(result.errors.length > 0, `${label} must not pass silently`)
  assert.ok(errorCodes(result).includes(expectedCode), `${label}: ${JSON.stringify(result.errors)}`)
  assert.ok(result.errors.every((error) => error.filePath === `${label}.yml`), label)
  assert.ok(result.errors.every((error) => error.line > 0 && error.column > 0), label)
  return result
}

test('parses plain and quoted action references while ignoring comments and run block scalars', () => {
  const source = `\uFEFFname: refs\r
on: push\r
jobs:\r
  validate:\r
    runs-on: ubuntu-latest\r
    steps:\r
      # uses: attacker/action@main\r
      - uses: actions/checkout@${LOWER_SHA} # v7\r
      - name: quoted\r
        'uses': 'owner/action/path@${UPPER_SHA}'\r
      - "uses": "owner/another@${LOWER_SHA}"\r
      - run: |\r
          echo "uses: attacker/action@main"\r
          echo '{ uses: attacker/action@main }'\r
      - run: >-\r
          echo uses: attacker/action@main\r
`

  const parsed = parseWorkflowUses(source, 'workflow.yml')

  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.references.map((reference) => reference.value), [
    `actions/checkout@${LOWER_SHA}`,
    `owner/action/path@${UPPER_SHA}`,
    `owner/another@${LOWER_SHA}`,
  ])
  assert.deepEqual(parsed.references.map((reference) => reference.line), [8, 10, 11])
  assert.ok(parsed.references.every((reference) => reference.context === 'step'))
})

test('normalizes every YAML spelling of an executable uses key before validation', () => {
  const mutableAction = 'actions/checkout@main'
  const mutableWorkflow = 'owner/repo/.github/workflows/a.yml@main'
  const cases = [
    ['block scalar sibling', `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: |
          harmless
        uses: ${mutableAction}
`, mutableAction],
    ['escaped quoted key', String.raw`jobs:
  call:
    "us\u0065s": owner/repo/.github/workflows/a.yml@main
`, mutableWorkflow],
    ['tagged key', `jobs:
  call:
    !!str uses: ${mutableWorkflow}
`, mutableWorkflow],
    ['flow mapping', `jobs: { call: { uses: ${mutableWorkflow} } }
`, mutableWorkflow],
    ['explicit key', `jobs:
  call:
    ? uses
    : ${mutableWorkflow}
`, mutableWorkflow],
    ['folded reference', `jobs:
  call:
    uses: >-
      ${mutableWorkflow}
`, mutableWorkflow],
  ]

  for (const [label, source, expectedValue] of cases) {
    const result = validateWorkflowActionReferences(source, `${label}.yml`)
    assert.deepEqual(result.references.map((reference) => reference.value), [expectedValue], label)
    assert.deepEqual(errorCodes(result), ['FULL_SHA_REQUIRED'], label)
  }
})

test('only inspects job-level and direct step-level executable uses keys', () => {
  const source = `on:
  workflow_dispatch:
    inputs:
      uses:
        type: string
env:
  uses: harmless-root-value
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      uses: harmless-job-value
    steps:
      - name: harmless nested keys
        env:
          uses: harmless-step-value
        with: { uses: harmless-input }
        run: echo *glob && echo '& tool'
      - uses: actions/checkout@${LOWER_SHA}
`

  const result = validateWorkflowActionReferences(source, 'contexts.yml')

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.references.map((reference) => reference.value), [
    `actions/checkout@${LOWER_SHA}`,
  ])
})

test('classifies immutable external and same-commit local workflow references by execution context', () => {
  for (const value of [
    `actions/checkout@${LOWER_SHA}`,
    `owner/repository/subdirectory/action@${UPPER_SHA}`,
  ]) {
    const result = classifyUsesReference(value, 'step')
    assert.equal(result.kind, 'external-action', value)
    assert.equal(result.code, undefined, value)
  }

  const externalWorkflow = classifyUsesReference(
    `owner/repository/.github/workflows/reusable.yml@${LOWER_SHA}`,
    'job',
  )
  assert.equal(externalWorkflow.kind, 'external-workflow')
  assert.equal(externalWorkflow.code, undefined)

  assert.deepEqual(
    classifyUsesReference('./.github/workflows/reusable.yaml', 'job'),
    { kind: 'local-workflow' },
  )
  assert.equal(
    classifyUsesReference('./.github/workflows/reusable.yaml', 'step').code,
    'LOCAL_ACTION_NOT_ALLOWED',
  )
  assert.equal(
    classifyUsesReference('./nested/reusable.yml', 'job').code,
    'INVALID_LOCAL_WORKFLOW_REFERENCE',
  )
  assert.equal(
    classifyUsesReference(`actions/checkout@${LOWER_SHA}`, 'job').code,
    'INVALID_EXTERNAL_WORKFLOW_REFERENCE',
  )
  assert.equal(
    classifyUsesReference(
      `owner/repository/.github/workflows/reusable.yml@${LOWER_SHA}`,
      'step',
    ).code,
    'REUSABLE_WORKFLOW_NOT_ALLOWED_IN_STEP',
  )
})

test('makes local action, local workflow, and Docker behavior explicit in complete workflows', () => {
  const source = `jobs:
  call:
    uses: ./.github/workflows/reusable.yaml
  invalid-local-call:
    uses: ./nested/reusable.yml
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:${'0'.repeat(64)}
`

  const result = validateWorkflowActionReferences(source, 'local-and-docker.yml')

  assert.deepEqual(result.counts, {
    external: 0,
    externalAction: 0,
    externalWorkflow: 0,
    localWorkflow: 2,
    localAction: 1,
    docker: 1,
  })
  assert.deepEqual(errorCodes(result), [
    'INVALID_LOCAL_WORKFLOW_REFERENCE',
    'LOCAL_ACTION_NOT_ALLOWED',
    'DOCKER_ACTION_NOT_ALLOWED',
  ])
})

test('rejects mutable, malformed, local-action, and Docker references', () => {
  const cases = [
    ['actions/checkout@main', 'FULL_SHA_REQUIRED'],
    ['actions/checkout@master', 'FULL_SHA_REQUIRED'],
    ['actions/checkout@release/v1', 'FULL_SHA_REQUIRED'],
    ['actions/checkout@v1', 'FULL_SHA_REQUIRED'],
    ['actions/checkout@1.2.3', 'FULL_SHA_REQUIRED'],
    [`actions/checkout@${'a'.repeat(39)}`, 'FULL_SHA_REQUIRED'],
    [`actions/checkout@${'a'.repeat(41)}`, 'FULL_SHA_REQUIRED'],
    [`actions/checkout@${'a'.repeat(39)}g`, 'FULL_SHA_REQUIRED'],
    ['actions/checkout', 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    ['actions/checkout@', 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    [`actions/checkout@extra@${LOWER_SHA}`, 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    [`https://github.com/actions/checkout@${LOWER_SHA}`, 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    [`owner//action@${LOWER_SHA}`, 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    [`owner/../action@${LOWER_SHA}`, 'INVALID_EXTERNAL_ACTION_REFERENCE'],
    [`actions/checkout@${LOWER_SHA} trailing`, 'INVALID_ACTION_REFERENCE'],
    ['${{ matrix.action }}', 'INVALID_ACTION_REFERENCE'],
    ['./.github/actions/local', 'LOCAL_ACTION_NOT_ALLOWED'],
    ['$/path/to/action', 'LOCAL_ACTION_NOT_ALLOWED'],
    ['docker://alpine:latest', 'DOCKER_ACTION_NOT_ALLOWED'],
    [`docker://alpine@sha256:${'0'.repeat(64)}`, 'DOCKER_ACTION_NOT_ALLOWED'],
  ]

  for (const [value, expectedCode] of cases) {
    assert.equal(classifyUsesReference(value, 'step').code, expectedCode, value)
  }
})

test('fails closed on aliases, anchors, merge keys, duplicate keys, and multiple documents', () => {
  const anchorAlias = assertRejectedSource('anchor-alias', `template: &step
  uses: actions/checkout@main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - *step
`, 'YAML_ANCHOR_NOT_ALLOWED')
  assert.ok(errorCodes(anchorAlias).includes('YAML_ALIAS_NOT_ALLOWED'))

  assertRejectedSource('numeric-anchor-key', `name: &0 uses
jobs:
  call:
    *0: owner/repo/.github/workflows/a.yml@main
`, 'INVALID_WORKFLOW_YAML')

  assertRejectedSource('merge-key', `template: &step
  uses: actions/checkout@main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - <<: *step
`, 'YAML_MERGE_NOT_ALLOWED')

  const duplicate = assertRejectedSource('duplicate-equivalent-key', String.raw`jobs:
  call:
    uses: owner/repo/.github/workflows/a.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    "us\u0065s": owner/repo/.github/workflows/a.yml@main
`, 'INVALID_WORKFLOW_YAML')
  assert.ok(duplicate.errors.some((error) => error.parserCode === 'DUPLICATE_KEY'))

  const multiple = assertRejectedSource('multiple-documents', `jobs:
  first:
    uses: owner/repo/.github/workflows/a.yml@${LOWER_SHA}
---
jobs:
  second:
    uses: owner/repo/.github/workflows/a.yml@main
`, 'MULTIPLE_YAML_DOCUMENTS')
  const multipleDocumentError = multiple.errors.find((error) => error.code === 'MULTIPLE_YAML_DOCUMENTS')
  assert.deepEqual(
    { line: multipleDocumentError.line, column: multipleDocumentError.column, value: multipleDocumentError.value },
    { line: 4, column: 1, value: '---' },
  )
})

test('rejects unsupported YAML versions and unresolved tags before trusting the AST', () => {
  const yaml11 = assertRejectedSource('yaml-1-1', `%YAML 1.1
---
jobs:
  call:
    uses: owner/repo/.github/workflows/a.yml@main
`, 'UNSUPPORTED_YAML_VERSION')
  assert.equal(yaml11.references.length, 0)

  const unknownTag = assertRejectedSource('unknown-tag', `jobs:
  call:
    uses: !mutable owner/repo/.github/workflows/a.yml@main
`, 'UNSUPPORTED_WORKFLOW_YAML')
  assert.ok(unknownTag.errors.some((error) => error.parserCode === 'TAG_RESOLVE_FAILED'))
  assert.equal(unknownTag.references.length, 0)
})

test('bounds workflow source size, AST breadth, diagnostics, and executable references', () => {
  const oversized = validateWorkflowActionReferences(
    'x'.repeat(WORKFLOW_VALIDATION_LIMITS.maxSourceBytes + 1),
    'oversized.yml',
  )
  assert.deepEqual(errorCodes(oversized), ['WORKFLOW_COMPLEXITY_LIMIT'])

  const wideMapping = Array.from(
    { length: Math.ceil(WORKFLOW_VALIDATION_LIMITS.maxAstNodes / 3) + 10 },
    (_value, index) => `  key-${index}: value`,
  ).join('\n')
  const wideAst = validateWorkflowActionReferences(`metadata:\n${wideMapping}\njobs: {}\n`, 'wide-ast.yml')
  assert.ok(errorCodes(wideAst).includes('WORKFLOW_COMPLEXITY_LIMIT'))

  const aliases = Array.from(
    { length: WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 10 },
    () => '  - *shared',
  ).join('\n')
  const diagnosticFlood = validateWorkflowActionReferences(
    `template: &shared harmless\naliases:\n${aliases}\njobs: {}\n`,
    'diagnostic-flood.yml',
  )
  assert.ok(errorCodes(diagnosticFlood).includes('WORKFLOW_COMPLEXITY_LIMIT'))
  assert.ok(diagnosticFlood.errors.length <= WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 1)

  const mutableSteps = Array.from(
    { length: WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 10 },
    () => '      - uses: actions/checkout@main',
  ).join('\n')
  const classificationFlood = validateWorkflowActionReferences(
    `jobs:\n  build:\n    steps:\n${mutableSteps}\n`,
    'classification-flood.yml',
  )
  assert.equal(classificationFlood.errors.length, WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 1)
  assert.equal(classificationFlood.errors.at(-1).code, 'WORKFLOW_COMPLEXITY_LIMIT')

  const numericSteps = Array.from(
    { length: WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 10 },
    () => '      - uses: 42',
  ).join('\n')
  const nonStringFlood = validateWorkflowActionReferences(
    `jobs:\n  build:\n    steps:\n${numericSteps}\n`,
    'non-string-flood.yml',
  )
  assert.equal(nonStringFlood.errors.length, WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 1)
  assert.equal(nonStringFlood.errors.at(-1).code, 'WORKFLOW_COMPLEXITY_LIMIT')

  const scalarSteps = Array.from(
    { length: WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 10 },
    () => '      - harmless',
  ).join('\n')
  const structureFlood = validateWorkflowActionReferences(
    `jobs:\n  build:\n    steps:\n${scalarSteps}\n`,
    'structure-flood.yml',
  )
  assert.equal(structureFlood.errors.length, WORKFLOW_VALIDATION_LIMITS.maxDiagnostics + 1)
  assert.equal(structureFlood.errors.at(-1).code, 'WORKFLOW_COMPLEXITY_LIMIT')

  const steps = Array.from(
    { length: WORKFLOW_VALIDATION_LIMITS.maxReferences + 1 },
    () => `      - uses: actions/checkout@${LOWER_SHA}`,
  ).join('\n')
  const referenceFlood = validateWorkflowActionReferences(
    `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`,
    'reference-flood.yml',
  )
  assert.equal(referenceFlood.references.length, WORKFLOW_VALIDATION_LIMITS.maxReferences)
  assert.ok(errorCodes(referenceFlood).includes('WORKFLOW_COMPLEXITY_LIMIT'))
})

test('recognizes CR-only workflow line endings instead of silently skipping references', () => {
  const source = [
    'jobs:',
    '  call:',
    '    uses: owner/repo/.github/workflows/a.yml@main',
    '',
  ].join('\r')

  const result = validateWorkflowActionReferences(source, 'cr-only.yml')

  assert.deepEqual(result.references.map((reference) => reference.value), [
    'owner/repo/.github/workflows/a.yml@main',
  ])
  assert.deepEqual(errorCodes(result), ['FULL_SHA_REQUIRED'])
  assert.deepEqual(result.errors.map(({ line, column }) => ({ line, column })), [
    { line: 3, column: 11 },
  ])
})

test('fails closed when executable workflow paths use unsupported structures or non-string refs', () => {
  const cases = [
    ['jobs-sequence', 'jobs: []\n', 'UNSUPPORTED_WORKFLOW_STRUCTURE'],
    ['steps-mapping', 'jobs:\n  build:\n    steps: {}\n', 'UNSUPPORTED_WORKFLOW_STRUCTURE'],
    ['scalar-step', 'jobs:\n  build:\n    steps:\n      - harmless\n', 'UNSUPPORTED_WORKFLOW_STRUCTURE'],
    ['mapping-ref', 'jobs:\n  call:\n    uses:\n      nested: value\n', 'INVALID_ACTION_REFERENCE'],
    ['numeric-ref', 'jobs:\n  call:\n    uses: 42\n', 'INVALID_ACTION_REFERENCE'],
  ]

  for (const [label, source, expectedCode] of cases) {
    assertRejectedSource(label, source, expectedCode)
  }
})

test('reports every invalid external reference with stable decoded values and locations', () => {
  const source = `jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
      - uses: 'owner/action@${'f'.repeat(39)}'
      - uses: "owner/action@${'0'.repeat(39)}z" # invalid hex
`

  const result = validateWorkflowActionReferences(source, 'invalid.yml')

  assert.deepEqual(errorCodes(result), [
    'FULL_SHA_REQUIRED',
    'FULL_SHA_REQUIRED',
    'FULL_SHA_REQUIRED',
  ])
  assert.deepEqual(result.errors.map(({ line, column }) => ({ line, column })), [
    { line: 5, column: 15 },
    { line: 6, column: 15 },
    { line: 7, column: 15 },
  ])
  assert.deepEqual(result.errors.map((error) => error.value), [
    'actions/checkout@main',
    `owner/action@${'f'.repeat(39)}`,
    `owner/action@${'0'.repeat(39)}z`,
  ])
})

test('discovers both workflow extensions at the directory root only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unreal-editor-webui-action-pins-'))
  try {
    writeFileSync(join(directory, 'one.yml'), 'name: one\n')
    writeFileSync(join(directory, 'two.yaml'), 'name: two\n')
    writeFileSync(join(directory, 'ignored.txt'), 'uses: bad/action@main\n')
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'nested', 'ignored.yml'), 'uses: bad/action@main\n')

    assert.deepEqual(
      discoverWorkflowFiles(directory).map((path) => basename(path)),
      ['one.yml', 'two.yaml'],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI validates multiple explicit files and emits actionable diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unreal-editor-webui-action-pins-cli-'))
  try {
    const validYml = join(directory, 'valid.yml')
    const validYaml = join(directory, 'valid.yaml')
    writeFileSync(validYml, `jobs:\n  call:\n    uses: owner/repo/.github/workflows/a.yml@${LOWER_SHA}\n`)
    writeFileSync(validYaml, `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${LOWER_SHA}\n`)

    const valid = spawnSync(process.execPath, [VALIDATOR_PATH, validYml, validYaml], { encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /Validated 2 external GitHub Action\/reusable-workflow references/u)

    const badYaml = join(directory, 'bad.yaml')
    writeFileSync(badYaml, 'jobs:\n  bad:\n    uses: owner/repo/.github/workflows/a.yml@main\n')
    const invalid = spawnSync(process.execPath, [VALIDATOR_PATH, badYaml], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /bad\.yaml:3:11 \[FULL_SHA_REQUIRED\]/u)
    assert.match(invalid.stderr, /owner\/repo\/\.github\/workflows\/a\.yml@main/u)

    const oversizedYaml = join(directory, 'oversized.yml')
    writeFileSync(oversizedYaml, 'x'.repeat(WORKFLOW_VALIDATION_LIMITS.maxSourceBytes + 1))
    const oversized = spawnSync(process.execPath, [VALIDATOR_PATH, oversizedYaml], { encoding: 'utf8' })
    assert.equal(oversized.status, 1)
    assert.match(oversized.stderr, /oversized\.yml:1:1 \[WORKFLOW_COMPLEXITY_LIMIT\]/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI default scan is repository-relative and empty directories fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unreal-editor-webui-action-pins-default-'))
  try {
    const defaultScan = spawnSync(process.execPath, [VALIDATOR_PATH], {
      cwd: directory,
      encoding: 'utf8',
    })
    assert.equal(defaultScan.status, 0, defaultScan.stderr)
    assert.match(defaultScan.stdout, /Validated 16 .* across 3 workflow files/u)

    const emptyScan = spawnSync(process.execPath, [VALIDATOR_PATH, directory], { encoding: 'utf8' })
    assert.equal(emptyScan.status, 1)
    assert.match(emptyScan.stderr, /No workflow \.yml or \.yaml files were found/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the real repository scan accounts for every executable action reference', () => {
  const workflowsDirectory = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
  const files = discoverWorkflowFiles(workflowsDirectory)
  const expectedCounts = new Map([
    ['ci.yml', 6],
    ['release-candidate.yml', 3],
    ['ue-ci.yml', 7],
  ])
  let externalReferences = 0

  assert.deepEqual(files.map((file) => basename(file)), [...expectedCounts.keys()])
  for (const file of files) {
    const result = validateWorkflowActionReferences(readFileSync(file, 'utf8'), file)
    assert.deepEqual(result.errors, [], file)
    assert.equal(result.references.length, expectedCounts.get(basename(file)), file)
    assert.equal(result.counts.external, expectedCounts.get(basename(file)), file)
    assert.ok(result.references.every((reference) => reference.classification.code === undefined), file)
    externalReferences += result.counts.external
  }

  assert.equal(externalReferences, 16)
})
