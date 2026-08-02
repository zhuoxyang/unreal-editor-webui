import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  visit,
} from 'yaml'

const WORKFLOW_EXTENSIONS = new Set(['.yml', '.yaml'])
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/u
const EXTERNAL_SEGMENT = /^[A-Za-z0-9_.-]+$/u
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[^/]+\.ya?ml$/u

export const WORKFLOW_VALIDATION_LIMITS = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxAstNodes: 10_000,
  maxDiagnostics: 100,
  maxReferences: 1_000,
})

function diagnostic(code, filePath, line, column, value, message, details = {}) {
  return { code, filePath, line, column, value, message, ...details }
}

function addComplexityDiagnostic(errors, filePath, line, column, value, message) {
  if (errors.some((error) => error.code === 'WORKFLOW_COMPLEXITY_LIMIT')) return
  errors.push(diagnostic(
    'WORKFLOW_COMPLEXITY_LIMIT', filePath, line, column, value, message,
  ))
}

function limitDiagnostics(errors, filePath) {
  if (errors.length <= WORKFLOW_VALIDATION_LIMITS.maxDiagnostics) return errors

  const firstOmitted = errors[WORKFLOW_VALIDATION_LIMITS.maxDiagnostics]
  const limited = errors.slice(0, WORKFLOW_VALIDATION_LIMITS.maxDiagnostics)
  addComplexityDiagnostic(
    limited,
    filePath,
    firstOmitted?.line ?? 1,
    firstOmitted?.column ?? 1,
    `${errors.length} diagnostics`,
    `Workflow validation produced more than ${WORKFLOW_VALIDATION_LIMITS.maxDiagnostics} diagnostics; remaining diagnostics were omitted.`,
  )
  return limited
}

function emptyReferenceCounts() {
  return {
    external: 0,
    externalAction: 0,
    externalWorkflow: 0,
    localWorkflow: 0,
    localAction: 0,
    docker: 0,
  }
}

function locationAt(lineCounter, node, fallbackOffset = 0) {
  const offset = node?.range?.[0] ?? fallbackOffset
  const position = lineCounter.linePos(offset)
  return {
    line: Math.max(position.line, 1),
    column: Math.max(position.col, 1),
  }
}

function sourceForNode(source, node, fallback = '') {
  if (!node?.range) return fallback
  return source.slice(node.range[0], node.range[1]).trim() || fallback
}

function scalarKey(node) {
  return isScalar(node) && typeof node.value === 'string' ? node.value : null
}

function pairsNamed(map, name) {
  return map.items.filter((pair) => scalarKey(pair.key) === name)
}

function addStructureError(errors, lineCounter, source, filePath, node, path, expected) {
  const location = locationAt(lineCounter, node)
  errors.push(diagnostic(
    'UNSUPPORTED_WORKFLOW_STRUCTURE',
    filePath,
    location.line,
    location.column,
    sourceForNode(source, node, path),
    `${path} must be ${expected}; unsupported workflow structures are rejected so action references cannot be hidden.`,
  ))
}

function addUsesReference(references, errors, lineCounter, source, filePath, pair, context, path) {
  const node = pair.value ?? pair.key
  const location = locationAt(lineCounter, node)

  if (references.length >= WORKFLOW_VALIDATION_LIMITS.maxReferences) {
    addComplexityDiagnostic(
      errors,
      filePath,
      location.line,
      location.column,
      path,
      `Workflow files may contain at most ${WORKFLOW_VALIDATION_LIMITS.maxReferences} executable action references.`,
    )
    return
  }

  if (!pair.value || !isScalar(pair.value) || typeof pair.value.value !== 'string') {
    errors.push(diagnostic(
      'INVALID_ACTION_REFERENCE',
      filePath,
      location.line,
      location.column,
      sourceForNode(source, node, ''),
      `${path} must be a non-empty YAML string.`,
    ))
    return
  }

  references.push({
    filePath,
    line: location.line,
    column: location.column,
    raw: sourceForNode(source, pair.value, pair.value.value),
    value: pair.value.value,
    context,
  })
}

function collectParserDiagnostics(documents, lineCounter, source, filePath) {
  const errors = []

  function addParserDiagnostic(error) {
    if (errors.length >= WORKFLOW_VALIDATION_LIMITS.maxDiagnostics) {
      addComplexityDiagnostic(
        errors,
        filePath,
        1,
        1,
        `${errors.length}+ YAML diagnostics`,
        `YAML parsing exceeded the limit of ${WORKFLOW_VALIDATION_LIMITS.maxDiagnostics} diagnostics.`,
      )
      return false
    }
    errors.push(error)
    return true
  }

  for (const document of documents) {
    for (const parserError of document.errors) {
      const offset = parserError.pos?.[0] ?? document.range?.[0] ?? 0
      const endOffset = parserError.pos?.[1] ?? offset
      const location = lineCounter.linePos(offset)
      if (!addParserDiagnostic(diagnostic(
        'INVALID_WORKFLOW_YAML',
        filePath,
        Math.max(location.line, 1),
        Math.max(location.col, 1),
        source.slice(offset, endOffset).trim() || parserError.code,
        `YAML parser error ${parserError.code}: ${parserError.message}`,
        { parserCode: parserError.code },
      ))) return errors
    }

    for (const parserWarning of document.warnings) {
      const offset = parserWarning.pos?.[0] ?? document.range?.[0] ?? 0
      const endOffset = parserWarning.pos?.[1] ?? offset
      const location = lineCounter.linePos(offset)
      if (!addParserDiagnostic(diagnostic(
        'UNSUPPORTED_WORKFLOW_YAML',
        filePath,
        Math.max(location.line, 1),
        Math.max(location.col, 1),
        source.slice(offset, endOffset).trim() || parserWarning.code,
        `YAML parser warning ${parserWarning.code}: ${parserWarning.message}`,
        { parserCode: parserWarning.code },
      ))) return errors
    }
  }

  return errors
}

function collectYamlPolicyDiagnostics(document, lineCounter, source, filePath) {
  const errors = []
  let visitedNodes = 0

  function inspectNode(node) {
    visitedNodes += 1
    if (visitedNodes <= WORKFLOW_VALIDATION_LIMITS.maxAstNodes) return true
    const location = locationAt(lineCounter, node)
    addComplexityDiagnostic(
      errors,
      filePath,
      location.line,
      location.column,
      `${visitedNodes}+ AST nodes`,
      `Workflow YAML exceeds the limit of ${WORKFLOW_VALIDATION_LIMITS.maxAstNodes} AST nodes.`,
    )
    return false
  }

  function addPolicyDiagnostic(error) {
    if (errors.length >= WORKFLOW_VALIDATION_LIMITS.maxDiagnostics) {
      addComplexityDiagnostic(
        errors,
        filePath,
        error.line,
        error.column,
        `${errors.length}+ policy diagnostics`,
        `Workflow YAML exceeded the limit of ${WORKFLOW_VALIDATION_LIMITS.maxDiagnostics} policy diagnostics.`,
      )
      return false
    }
    errors.push(error)
    return true
  }

  if (document.directives?.yaml.explicit && document.directives.yaml.version !== '1.2') {
    errors.push(diagnostic(
      'UNSUPPORTED_YAML_VERSION',
      filePath,
      1,
      1,
      `%YAML ${document.directives.yaml.version}`,
      'Workflow validation only supports YAML 1.2 documents.',
    ))
  }

  try {
    visit(document, {
      Alias(_key, node) {
        if (!inspectNode(node)) return visit.BREAK
        const location = locationAt(lineCounter, node)
        if (!addPolicyDiagnostic(diagnostic(
          'YAML_ALIAS_NOT_ALLOWED',
          filePath,
          location.line,
          location.column,
          `*${node.source}`,
          'YAML aliases are not allowed because every executable action reference must remain directly auditable.',
        ))) return visit.BREAK
      },
      Node(_key, node) {
        if (!inspectNode(node)) return visit.BREAK
        if (!node.anchor) return
        const location = locationAt(lineCounter, node)
        if (!addPolicyDiagnostic(diagnostic(
          'YAML_ANCHOR_NOT_ALLOWED',
          filePath,
          location.line,
          location.column,
          `&${node.anchor}`,
          'YAML anchors are not allowed because every executable action reference must remain directly auditable.',
        ))) return visit.BREAK
      },
      Pair(_key, pair) {
        if (!inspectNode(pair)) return visit.BREAK
        if (scalarKey(pair.key) !== '<<') return
        const location = locationAt(lineCounter, pair.key)
        if (!addPolicyDiagnostic(diagnostic(
          'YAML_MERGE_NOT_ALLOWED',
          filePath,
          location.line,
          location.column,
          sourceForNode(source, pair.key, '<<'),
          'YAML merge keys are not allowed because they can hide executable action references.',
        ))) return visit.BREAK
      },
    })
  } catch (error) {
    errors.push(diagnostic(
      'WORKFLOW_AST_TRAVERSAL_FAILED',
      filePath,
      1,
      1,
      '',
      `Workflow AST traversal failed closed: ${error instanceof Error ? error.message : String(error)}`,
    ))
  }

  return errors
}

export function parseWorkflowUses(source, filePath = '<workflow>') {
  if (typeof source !== 'string') throw new TypeError('Workflow source must be a string.')

  const references = []
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  if (sourceBytes > WORKFLOW_VALIDATION_LIMITS.maxSourceBytes) {
    return {
      references,
      errors: [diagnostic(
        'WORKFLOW_COMPLEXITY_LIMIT',
        filePath,
        1,
        1,
        `${sourceBytes} bytes`,
        `Workflow source exceeds the ${WORKFLOW_VALIDATION_LIMITS.maxSourceBytes}-byte validation limit.`,
      )],
    }
  }

  const lineCounter = new LineCounter()
  // YAML recognizes a bare carriage return as a line break. Replacing only bare CRs
  // preserves every character offset, so AST ranges still map back to the source.
  const parserSource = source.replace(/\r(?!\n)/gu, '\n')
  let documents

  try {
    documents = parseAllDocuments(parserSource, {
      lineCounter,
      version: '1.2',
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
      logLevel: 'error',
    })
  } catch (error) {
    return {
      references,
      errors: [diagnostic(
        'INVALID_WORKFLOW_YAML',
        filePath,
        1,
        1,
        '',
        `The YAML parser could not read this workflow: ${error instanceof Error ? error.message : String(error)}`,
      )],
    }
  }

  const errors = collectParserDiagnostics(documents, lineCounter, source, filePath)
  if (documents.length !== 1) {
    const extraDocument = documents[1]
    const offset = extraDocument?.range?.[0] ?? 0
    const position = lineCounter.linePos(offset)
    errors.push(diagnostic(
      'MULTIPLE_YAML_DOCUMENTS',
      filePath,
      Math.max(position.line, 1),
      Math.max(position.col, 1),
      '---',
      `Workflow files must contain exactly one YAML document; found ${documents.length}.`,
    ))
  }

  if (documents.length !== 1 || errors.length > 0) return { references, errors }

  const document = documents[0]
  errors.push(...collectYamlPolicyDiagnostics(document, lineCounter, source, filePath))
  if (errors.length > 0) return { references, errors }

  if (document.contents === null) return { references, errors }
  if (!isMap(document.contents)) {
    addStructureError(errors, lineCounter, source, filePath, document.contents, 'workflow root', 'a mapping')
    return { references, errors }
  }

  const jobsPairs = pairsNamed(document.contents, 'jobs')
  if (jobsPairs.length === 0) return { references, errors }
  if (jobsPairs.length !== 1) {
    addStructureError(errors, lineCounter, source, filePath, jobsPairs[1]?.key, 'jobs', 'a unique mapping')
    return { references, errors }
  }

  const jobs = jobsPairs[0].value
  if (!jobs || !isMap(jobs)) {
    addStructureError(errors, lineCounter, source, filePath, jobs ?? jobsPairs[0].key, 'jobs', 'a mapping')
    return { references, errors }
  }

  for (const jobPair of jobs.items) {
    const jobName = scalarKey(jobPair.key) ?? '<job>'
    const job = jobPair.value
    if (!job || !isMap(job)) {
      addStructureError(errors, lineCounter, source, filePath, job ?? jobPair.key, `jobs.${jobName}`, 'a mapping')
      continue
    }

    for (const usesPair of pairsNamed(job, 'uses')) {
      addUsesReference(
        references,
        errors,
        lineCounter,
        source,
        filePath,
        usesPair,
        'job',
        `jobs.${jobName}.uses`,
      )
    }

    const stepsPairs = pairsNamed(job, 'steps')
    if (stepsPairs.length === 0) continue
    if (stepsPairs.length !== 1) {
      addStructureError(
        errors,
        lineCounter,
        source,
        filePath,
        stepsPairs[1]?.key,
        `jobs.${jobName}.steps`,
        'a unique sequence',
      )
      continue
    }

    const steps = stepsPairs[0].value
    if (!steps || !isSeq(steps)) {
      addStructureError(
        errors,
        lineCounter,
        source,
        filePath,
        steps ?? stepsPairs[0].key,
        `jobs.${jobName}.steps`,
        'a sequence',
      )
      continue
    }

    for (let stepIndex = 0; stepIndex < steps.items.length; stepIndex += 1) {
      const step = steps.items[stepIndex]
      if (!step || !isMap(step)) {
        addStructureError(
          errors,
          lineCounter,
          source,
          filePath,
          step ?? steps,
          `jobs.${jobName}.steps[${stepIndex}]`,
          'a mapping',
        )
        continue
      }

      for (const usesPair of pairsNamed(step, 'uses')) {
        addUsesReference(
          references,
          errors,
          lineCounter,
          source,
          filePath,
          usesPair,
          'step',
          `jobs.${jobName}.steps[${stepIndex}].uses`,
        )
      }
    }
  }

  return { references, errors }
}

export function classifyUsesReference(value, context = 'step') {
  if (typeof value !== 'string' || value === '' || /[\s\0]/u.test(value)) {
    return {
      kind: 'unsupported',
      code: 'INVALID_ACTION_REFERENCE',
      message: 'The uses reference contains whitespace, a NUL byte, or is empty.',
    }
  }

  if (value.startsWith('docker://')) {
    return {
      kind: 'docker',
      code: 'DOCKER_ACTION_NOT_ALLOWED',
      message: 'Docker actions are not allowed until an immutable image-digest policy is implemented.',
    }
  }

  if (value.startsWith('./')) {
    if (context === 'job') {
      if (LOCAL_WORKFLOW.test(value) && !value.split('/').includes('..') && !value.includes('@')) {
        return { kind: 'local-workflow' }
      }
      return {
        kind: 'local-workflow',
        code: 'INVALID_LOCAL_WORKFLOW_REFERENCE',
        message: 'Job-level local reusable workflows must use ./.github/workflows/<file>.yml without a ref.',
      }
    }

    return {
      kind: 'local-action',
      code: 'LOCAL_ACTION_NOT_ALLOWED',
      message: 'Local actions are not allowed until their action metadata and nested uses references are scanned.',
    }
  }

  if (value.startsWith('$/')) {
    return {
      kind: 'local-action',
      code: 'LOCAL_ACTION_NOT_ALLOWED',
      message: 'Repository-local actions are not allowed until their metadata and nested uses references are scanned.',
    }
  }

  const firstAt = value.indexOf('@')
  const lastAt = value.lastIndexOf('@')
  const externalKind = context === 'job' ? 'external-workflow' : 'external-action'
  if (firstAt <= 0 || firstAt !== lastAt || firstAt === value.length - 1) {
    return {
      kind: externalKind,
      code: 'INVALID_EXTERNAL_ACTION_REFERENCE',
      message: 'External actions and reusable workflows must use owner/repository[/path]@commit.',
    }
  }

  const locator = value.slice(0, firstAt)
  const ref = value.slice(firstAt + 1)
  const segments = locator.split('/')
  if (
    segments.length < 2 ||
    segments.some((segment) => !EXTERNAL_SEGMENT.test(segment) || segment === '.' || segment === '..')
  ) {
    return {
      kind: externalKind,
      code: 'INVALID_EXTERNAL_ACTION_REFERENCE',
      message: 'The external action or reusable-workflow locator is invalid.',
    }
  }

  const reusableWorkflowLocator =
    segments.length === 5 &&
    segments[2] === '.github' &&
    segments[3] === 'workflows' &&
    /\.ya?ml$/u.test(segments[4])
  if (context === 'job' && !reusableWorkflowLocator) {
    return {
      kind: externalKind,
      code: 'INVALID_EXTERNAL_WORKFLOW_REFERENCE',
      message: 'Job-level external reusable workflows must use owner/repository/.github/workflows/<file>.yml@commit.',
    }
  }
  if (context === 'step' && reusableWorkflowLocator) {
    return {
      kind: externalKind,
      code: 'REUSABLE_WORKFLOW_NOT_ALLOWED_IN_STEP',
      message: 'Reusable workflow files may only be referenced by a job-level uses key.',
    }
  }

  if (!FULL_COMMIT_SHA.test(ref)) {
    return {
      kind: externalKind,
      locator,
      ref,
      code: 'FULL_SHA_REQUIRED',
      message: 'External actions and reusable workflows must use a full 40-character hexadecimal commit SHA.',
    }
  }

  return { kind: externalKind, locator, ref }
}

export function validateWorkflowActionReferences(source, filePath = '<workflow>') {
  const parsed = parseWorkflowUses(source, filePath)
  const errors = [...parsed.errors]
  const counts = emptyReferenceCounts()
  const references = parsed.references.map((reference) => {
    const classification = classifyUsesReference(reference.value, reference.context)
    if (classification.kind === 'external-action') {
      counts.external += 1
      counts.externalAction += 1
    } else if (classification.kind === 'external-workflow') {
      counts.external += 1
      counts.externalWorkflow += 1
    } else if (classification.kind === 'local-workflow') counts.localWorkflow += 1
    else if (classification.kind === 'local-action') counts.localAction += 1
    else if (classification.kind === 'docker') counts.docker += 1

    if (classification.code) {
      errors.push(diagnostic(
        classification.code,
        reference.filePath,
        reference.line,
        reference.column,
        reference.value,
        classification.message,
      ))
    }
    return { ...reference, classification }
  })

  return { references, errors: limitDiagnostics(errors, filePath), counts }
}

export function discoverWorkflowFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && WORKFLOW_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => resolve(directory, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

function inputFiles(inputs, defaultDirectory) {
  const candidates = inputs.length > 0 ? inputs.map((input) => resolve(input)) : [defaultDirectory]
  const files = new Set()

  for (const candidate of candidates) {
    const metadata = statSync(candidate)
    if (metadata.isDirectory()) {
      for (const file of discoverWorkflowFiles(candidate)) files.add(file)
    } else if (metadata.isFile() && WORKFLOW_EXTENSIONS.has(extname(candidate).toLowerCase())) {
      files.add(candidate)
    } else {
      throw new Error(`Expected a workflow .yml/.yaml file or directory: ${candidate}`)
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right))
}

function runCli() {
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const defaultDirectory = resolve(repositoryRoot, '.github/workflows')

  try {
    const files = inputFiles(process.argv.slice(2), defaultDirectory)
    if (files.length === 0) throw new Error('No workflow .yml or .yaml files were found.')

    const results = files.map((file) => {
      const displayPath = relative(repositoryRoot, file).replaceAll('\\', '/') || file
      const sourceBytes = statSync(file).size
      if (sourceBytes > WORKFLOW_VALIDATION_LIMITS.maxSourceBytes) {
        return {
          references: [],
          errors: [diagnostic(
            'WORKFLOW_COMPLEXITY_LIMIT',
            displayPath,
            1,
            1,
            `${sourceBytes} bytes`,
            `Workflow source exceeds the ${WORKFLOW_VALIDATION_LIMITS.maxSourceBytes}-byte validation limit.`,
          )],
          counts: emptyReferenceCounts(),
        }
      }
      return validateWorkflowActionReferences(readFileSync(file, 'utf8'), displayPath)
    })
    const errors = results.flatMap((result) => result.errors)
      .sort((left, right) =>
        left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column,
      )

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(
          `${error.filePath}:${error.line}:${error.column} [${error.code}] ${error.message} Received ${JSON.stringify(error.value)}.`,
        )
      }
      process.exitCode = 1
      return
    }

    const counts = results.reduce((total, result) => ({
      external: total.external + result.counts.external,
      externalAction: total.externalAction + result.counts.externalAction,
      externalWorkflow: total.externalWorkflow + result.counts.externalWorkflow,
      localWorkflow: total.localWorkflow + result.counts.localWorkflow,
      localAction: total.localAction + result.counts.localAction,
      docker: total.docker + result.counts.docker,
    }), emptyReferenceCounts())
    console.log(
      `Validated ${counts.external} external GitHub Action/reusable-workflow references across ${files.length} workflow files; every external ref uses a full commit SHA.`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli()
}
