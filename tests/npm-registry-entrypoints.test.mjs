import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parse } from 'yaml'

import { validateNpmLockRegistry } from '../scripts/validate-npm-lock-registry.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_DIRECTORY = join(REPOSITORY_ROOT, '.github', 'workflows')
const CANONICAL_GUARD = 'node scripts/validate-npm-lock-registry.mjs'
const NPM_INSTALL_SUBCOMMAND_PATTERN = [
  'add',
  'ci',
  'cit',
  'clean-install',
  'clean-install-test',
  'i',
  'ic',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'install',
  'install-ci-test',
  'install-clean',
  'install-test',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'isntall-clean',
  'it',
  'sit',
].join('|')

const EXPECTED_WORKFLOW_CONSUMERS = new Map([
  [
    '.github/workflows/ci.yml#frontend#Install repository tooling dependencies#npm-install#1',
    {
      command: 'npm ci --ignore-scripts --include=dev --no-audit --no-fund',
      lockfile: 'package-lock.json',
      workingDirectory: '.',
    },
  ],
  [
    '.github/workflows/ci.yml#frontend#Install frontend dependencies#npm-install#1',
    {
      command: 'npm ci',
      lockfile: 'frontend/package-lock.json',
      workingDirectory: 'frontend',
    },
  ],
  [
    '.github/workflows/ci.yml#repository#Install repository tooling dependencies#npm-install#1',
    {
      command: 'npm ci --ignore-scripts --include=dev --no-audit --no-fund',
      lockfile: 'package-lock.json',
      workingDirectory: '.',
    },
  ],
  [
    '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#dependency-export#1',
    {
      command:
        'node scripts/export-npm-dependencies.mjs frontend/package-lock.json release/metadata/npm-dependencies.json',
      lockfile: 'frontend/package-lock.json',
    },
  ],
  [
    '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#npm-sbom#1',
    {
      command:
        'npm sbom --prefix frontend --package-lock-only --sbom-format cyclonedx --sbom-type application > release/metadata/npm-cyclonedx.json',
      lockfile: 'frontend/package-lock.json',
    },
  ],
  [
    '.github/workflows/ue-ci.yml#fast-checks#Install frontend dependencies#npm-install#1',
    {
      command: 'npm ci',
      lockfile: 'frontend/package-lock.json',
      workingDirectory: 'frontend',
    },
  ],
])

function repositoryPath(path) {
  return relative(REPOSITORY_ROOT, path).replaceAll('\\', '/')
}

function readRepositoryFile(path) {
  return readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
}

function loadWorkflows() {
  return readdirSync(WORKFLOW_DIRECTORY, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && (extname(entry.name) === '.yml' || extname(entry.name) === '.yaml'),
    )
    .map((entry) => {
      const path = join(WORKFLOW_DIRECTORY, entry.name)
      return {
        path,
        relativePath: repositoryPath(path),
        workflow: parse(readFileSync(path, 'utf8')),
      }
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function findUnconditionalGuard(steps, lockfilePath) {
  const command = `${CANONICAL_GUARD} ${lockfilePath}`
  return steps.findIndex(
    (step) =>
      typeof step?.run === 'string' &&
      step.run.trim() === command &&
      step.if === undefined &&
      (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
  )
}

function enumerateWorkflowConsumers(workflows) {
  const consumers = []
  for (const { relativePath, workflow } of workflows) {
    assert.ok(workflow?.jobs && typeof workflow.jobs === 'object', `${relativePath} has no jobs`)
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : []
      for (const [stepIndex, step] of steps.entries()) {
        if (typeof step?.run !== 'string') continue
        const stepName = typeof step.name === 'string' ? step.name : `step-${stepIndex + 1}`
        const ordinals = new Map()
        for (const kind of scanCommandConsumers(step.run)) {
          const ordinal = (ordinals.get(kind) ?? 0) + 1
          ordinals.set(kind, ordinal)
          consumers.push({
            id: `${relativePath}#${jobName}#${stepName}#${kind}#${ordinal}`,
            job,
            jobName,
            kind,
            relativePath,
            step,
            stepIndex,
            steps,
            workflow,
          })
        }
      }
    }
  }
  return consumers
}

function scanCommandConsumers(source) {
  const normalizedSource = source.replace(/(?:\\|`)\r?\n/gu, ' ')
  const consumers = []
  const patterns = [
    {
      kind: 'npm-install',
      pattern: new RegExp(
        String.raw`(?:^|[\s;&|()])(?:&\s*)?npm(?:\.cmd|\.exe)?\b[^\r\n;&|()]*?\s+(?:${NPM_INSTALL_SUBCOMMAND_PATTERN})\b`,
        'gmu',
      ),
    },
    {
      kind: 'npm-sbom',
      pattern:
        /(?:^|[\s;&|()])(?:&\s*)?npm(?:\.cmd|\.exe)?\b[^\r\n;&|()]*?\s+sbom\b/gmu,
    },
    {
      kind: 'dependency-export',
      pattern:
        /(?:^|[\s;&|()])(?:&\s*)?node(?:\.exe)?\s+(?:\.?[\\/])?scripts[\\/]export-npm-dependencies\.mjs\b/gmu,
    },
  ]

  for (const { kind, pattern } of patterns) {
    for (const _match of normalizedSource.matchAll(pattern)) consumers.push(kind)
  }

  const javascriptInstallPatterns = [
    new RegExp(
      String.raw`\brunNpm\s*\(\s*npmLauncher\s*,\s*\[\s*['"\x60](?:${NPM_INSTALL_SUBCOMMAND_PATTERN})['"\x60]`,
      'gu',
    ),
    new RegExp(
      String.raw`\b(?:spawn|spawnSync|execFile|execFileSync|run|call|check_call|check_output|Popen)\s*\(\s*\[?\s*['"\x60]npm(?:\.cmd|\.exe)?['"\x60][^\]]*?['"\x60](?:${NPM_INSTALL_SUBCOMMAND_PATTERN})['"\x60]`,
      'gu',
    ),
    new RegExp(
      String.raw`\bexec(?:Sync)?\s*\(\s*['"\x60]npm(?:\.cmd|\.exe)?\b[^'"\x60]*?\s(?:${NPM_INSTALL_SUBCOMMAND_PATTERN})\b`,
      'gu',
    ),
    new RegExp(
      String.raw`\bStart-Process\s+(?:-FilePath\s+)?['"\x60]npm(?:\.cmd|\.exe)?['"\x60][^\r\n]*?['"\x60](?:${NPM_INSTALL_SUBCOMMAND_PATTERN})['"\x60]`,
      'giu',
    ),
    new RegExp(
      String.raw`(?:^|[\s;&|()])&\s*['"\x60]npm(?:\.cmd|\.exe)?['"\x60][^\r\n;&|()]*?\s+(?:${NPM_INSTALL_SUBCOMMAND_PATTERN})\b`,
      'gmu',
    ),
  ]
  for (const pattern of javascriptInstallPatterns) {
    for (const _match of normalizedSource.matchAll(pattern)) consumers.push('npm-install')
  }
  return consumers
}

function trackedRepositoryFiles() {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\t')
      assert.ok(separator > 0, `unexpected git ls-files record: ${record}`)
      const [mode] = record.slice(0, separator).split(' ')
      return { executable: mode === '100755', path: record.slice(separator + 1) }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function enumerateTrackedEntrypointConsumers() {
  const commandExtensions = new Set(['.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh'])
  const consumers = []
  for (const trackedFile of trackedRepositoryFiles()) {
    const relativePath = trackedFile.path
    if (relativePath.startsWith('tests/') || relativePath.startsWith('.github/workflows/')) {
      continue
    }

    if (relativePath.endsWith('package.json')) {
      const manifest = JSON.parse(readRepositoryFile(relativePath))
      for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
        if (typeof command !== 'string') continue
        const ordinals = new Map()
        for (const kind of scanCommandConsumers(command)) {
          const ordinal = (ordinals.get(kind) ?? 0) + 1
          ordinals.set(kind, ordinal)
          consumers.push(`${relativePath}#package-script:${scriptName}#${kind}#${ordinal}`)
        }
      }
      continue
    }

    const basename = relativePath.split('/').at(-1)
    const isCommandFile =
      trackedFile.executable ||
      commandExtensions.has(extname(relativePath)) ||
      /^(?:Dockerfile|Justfile|Makefile)$/u.test(basename) ||
      /^Taskfile\.(?:yml|yaml)$/u.test(basename) ||
      (/^\.github\/actions\//u.test(relativePath) && /action\.(?:yml|yaml)$/u.test(basename))
    if (!isCommandFile) continue

    const ordinals = new Map()
    let source = readRepositoryFile(relativePath)
    if (relativePath === 'scripts/export-npm-dependencies.mjs') {
      source = source.replaceAll('scripts/export-npm-dependencies.mjs', '')
    }
    for (const kind of scanCommandConsumers(source)) {
      const ordinal = (ordinals.get(kind) ?? 0) + 1
      ordinals.set(kind, ordinal)
      consumers.push(`${relativePath}#${kind}#${ordinal}`)
    }
  }
  return consumers
}

function assertOrdered(source, labelsAndNeedles) {
  let previousIndex = -1
  for (const [label, needle] of labelsAndNeedles) {
    const index = source.indexOf(needle)
    assert.notEqual(index, -1, `${label} is missing`)
    assert.ok(index > previousIndex, `${label} is out of order`)
    previousIndex = index
  }
}

function logicalCommands(source) {
  return source
    .replace(/(?:\\|`)\r?\n[\t ]*/gu, ' ')
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/[\t ]+/gu, ' '))
    .filter(Boolean)
}

function assertNoNpmLocationOverride(consumer) {
  assert.doesNotMatch(
    consumer.step.run,
    /npm_config_(?:prefix|userconfig)/iu,
    `${consumer.id} must not override npm's lockfile location`,
  )
  for (const [scopeName, environment] of [
    ['workflow', consumer.workflow.env],
    ['job', consumer.job.env],
    ['step', consumer.step.env],
  ]) {
    if (!environment || typeof environment !== 'object') continue
    const override = Object.keys(environment).find((name) =>
      /^npm_config_(?:prefix|userconfig)$/iu.test(name),
    )
    assert.equal(override, undefined, `${consumer.id} has a ${scopeName} ${override} override`)
  }
}

test('every executable npm lockfile consumer has an earlier fail-closed guard', () => {
  const workflows = loadWorkflows()
  const consumers = enumerateWorkflowConsumers(workflows)
  assert.deepEqual(
    consumers.map(({ id }) => id).sort(),
    [...EXPECTED_WORKFLOW_CONSUMERS.keys()].sort(),
    'workflow lockfile consumers changed; classify the new entrypoint and add its guard',
  )

  for (const consumer of consumers) {
    const expected = EXPECTED_WORKFLOW_CONSUMERS.get(consumer.id)
    const guardIndex = findUnconditionalGuard(consumer.steps, expected.lockfile)
    assert.notEqual(
      guardIndex,
      -1,
      `${consumer.id} lacks an unconditional canonical guard for ${expected.lockfile}`,
    )
    assert.ok(
      guardIndex < consumer.stepIndex,
      `${consumer.id} runs before its ${expected.lockfile} guard`,
    )
    assert.equal(
      guardIndex + 1,
      consumer.stepIndex,
      `${consumer.id} must immediately follow its guard to prevent lockfile mutation`,
    )
    assert.equal(consumer.step.if, undefined, `${consumer.id} must use the default success() gate`)
    assert.ok(
      consumer.step['continue-on-error'] === undefined ||
        consumer.step['continue-on-error'] === false,
      `${consumer.id} must fail closed`,
    )
    assertNoNpmLocationOverride(consumer)
    assert.ok(
      logicalCommands(consumer.step.run).includes(expected.command),
      `${consumer.id} must use the approved lockfile-consuming command`,
    )

    if (consumer.relativePath === '.github/workflows/release-candidate.yml') {
      assert.deepEqual(
        logicalCommands(consumer.step.run),
        [
          'set -euo pipefail',
          'mkdir -p release/metadata',
          EXPECTED_WORKFLOW_CONSUMERS.get(
            '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#npm-sbom#1',
          ).command,
          EXPECTED_WORKFLOW_CONSUMERS.get(
            '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#dependency-export#1',
          ).command,
        ],
        `${consumer.id} release metadata step contains an unapproved command`,
      )
    } else if (consumer.kind === 'npm-install') {
      const workingDirectory =
        consumer.step['working-directory'] ??
        consumer.job.defaults?.run?.['working-directory'] ??
        consumer.workflow.defaults?.run?.['working-directory'] ??
        '.'
      assert.equal(
        workingDirectory,
        expected.workingDirectory,
        `${consumer.id} no longer consumes ${expected.lockfile}`,
      )
      assert.deepEqual(
        logicalCommands(consumer.step.run),
        [expected.command],
        `${consumer.id} must contain only its approved npm ci command`,
      )
    }
  }

  assert.deepEqual(
    enumerateTrackedEntrypointConsumers(),
    ['scripts/stage-plugin-from-commit.mjs#npm-install#1'],
    'script lockfile consumers changed; classify the new entrypoint and add its guard',
  )
})

test('entrypoint discovery recognizes alternate install forms without matching diagnostics', () => {
  for (const source of [
    'npm --prefix frontend ci',
    'npm --prefix frontend sbom --package-lock-only',
    'npm clean-install',
    'npm add',
    'npm cit',
    'npm install-test',
    'command npm ci',
    'cd frontend && npm ci',
    'npm \\\n      ci',
    "spawnSync('npm', ['ci'])",
    "runNpm(npmLauncher, ['ci'], frontendDirectory, 'exact install')",
    "exec('npm install')",
    "subprocess.run(['npm', 'ci'])",
    "Start-Process 'npm' -ArgumentList 'ci'",
    'node ./scripts/export-npm-dependencies.mjs frontend/package-lock.json output.json',
  ]) {
    assert.ok(scanCommandConsumers(source).length > 0, source)
  }
  assert.ok(
    scanCommandConsumers('npm --prefix frontend sbom --package-lock-only').includes('npm-sbom'),
  )
  assert.ok(
    scanCommandConsumers(
      'node ./scripts/export-npm-dependencies.mjs frontend/package-lock.json output.json',
    ).includes('dependency-export'),
  )

  for (const source of [
    'echo "npm ci"',
    'throw new Error("npm ci failed")',
    'npm run build',
    'node --check scripts/export-npm-dependencies.mjs',
  ]) {
    assert.deepEqual(scanCommandConsumers(source), [], source)
  }
})

test('approved consumer commands bind exact lockfile arguments', () => {
  const frontendInstall = EXPECTED_WORKFLOW_CONSUMERS.get(
    '.github/workflows/ue-ci.yml#fast-checks#Install frontend dependencies#npm-install#1',
  ).command
  const releaseSbom = EXPECTED_WORKFLOW_CONSUMERS.get(
    '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#npm-sbom#1',
  ).command
  const releaseExport = EXPECTED_WORKFLOW_CONSUMERS.get(
    '.github/workflows/release-candidate.yml#assemble#Generate SBOM and locked dependency inventory#dependency-export#1',
  ).command

  assert.deepEqual(logicalCommands(frontendInstall), [frontendInstall])
  assert.deepEqual(logicalCommands(releaseSbom), [releaseSbom])
  assert.deepEqual(logicalCommands(releaseExport), [releaseExport])
  assert.notEqual(logicalCommands('npm ci --prefix other')[0], frontendInstall)
  assert.notEqual(
    logicalCommands(releaseSbom.replace('--prefix frontend', '--prefix frontend-other'))[0],
    releaseSbom,
  )
  assert.notEqual(
    logicalCommands(releaseSbom.replace('--package-lock-only', '--package-lock-only=false'))[0],
    releaseSbom,
  )
  assert.notEqual(
    logicalCommands(releaseExport.replace('package-lock.json', 'package-lock.json-evil'))[0],
    releaseExport,
  )
})

test('release dependency validation is immediately before metadata generation', () => {
  const releaseWorkflow = loadWorkflows().find(
    ({ relativePath }) => relativePath === '.github/workflows/release-candidate.yml',
  )?.workflow
  assert.ok(releaseWorkflow)
  const steps = releaseWorkflow.jobs.assemble.steps
  const guardIndex = findUnconditionalGuard(steps, 'frontend/package-lock.json')
  const metadataIndex = steps.findIndex(
    (step) => step.name === 'Generate SBOM and locked dependency inventory',
  )
  const archiveIndex = steps.findIndex((step) => step.name === 'Create candidate archive and SHA-256')

  assert.equal(guardIndex + 1, metadataIndex, 'release lock guard must immediately precede metadata')
  assert.ok(guardIndex < archiveIndex, 'release lock guard must run before candidate assembly')
})

test('exact-commit staging guards the consumed lock before install, build, and RunUAT', () => {
  const powershell = readRepositoryFile('scripts/package-plugin.ps1')
  assertOrdered(powershell, [
    ['PowerShell exact-commit stage helper', '& node $StageScript $SourceCommit $PluginStage $SourceManifest'],
    ['PowerShell stage exit-code capture', '$StageExitCode = $LASTEXITCODE'],
    ['PowerShell stage failure check', 'if ($StageExitCode -ne 0)'],
    ['PowerShell RunUAT', '& $RunUATPath BuildPlugin'],
  ])
  assert.doesNotMatch(powershell, /\$FrontendDir|robocopy|Copy-Item -LiteralPath \$LicenseFile/u)

  const bash = readRepositoryFile('scripts/package-plugin.sh')
  assert.match(bash, /^set -euo pipefail$/mu)
  assertOrdered(bash, [
    ['Bash staging allocation', 'STAGING_DIR="$(mktemp -d)"'],
    ['Bash exact-commit stage helper', 'node "$STAGE_SCRIPT" "$SOURCE_COMMIT" "$PLUGIN_STAGE" "$SOURCE_MANIFEST"'],
    ['Bash RunUAT', '"$RUN_UAT" BuildPlugin'],
  ])
  assert.doesNotMatch(bash, /FRONTEND_DIR|rsync|cp "\$ROOT_DIR\/LICENSE"/u)

  const staging = readRepositoryFile('scripts/stage-plugin-from-commit.mjs')
  assertOrdered(staging, [
    [
      'exact-commit registry validator',
      'const registryValidator = await import(pathToFileURL(registryValidatorPath).href)',
    ],
    ['exact-commit lockfile', "filesystemPath(buildRoot, 'frontend/package-lock.json')"],
    [
      'exact-commit npm install',
      "runNpm(npmLauncher, ['ci'], frontendDirectory, 'Exact-commit dependency installation')",
    ],
    [
      'post-install generated-output gate',
      'must be created by the frontend build, not dependency installation',
    ],
    [
      'exact-commit frontend build',
      "runNpm(npmLauncher, ['run', 'build'], frontendDirectory, 'Exact-commit frontend build')",
    ],
    [
      'fresh tracked plugin materialization',
      'const trackedFiles = materializeEntries(pluginEntries, pluginStage)',
    ],
    [
      'generated dist overlay',
      'const generatedFiles = overlayGeneratedWeb(buildRoot, pluginStage)',
    ],
  ])
})

test('documented npm installs validate the same lockfile first', () => {
  const contracts = [
    {
      file: 'README.md',
      guards: [
        `${CANONICAL_GUARD} frontend/package-lock.json`,
        `${CANONICAL_GUARD} frontend/package-lock.json`,
        `${CANONICAL_GUARD} package-lock.json`,
      ],
    },
    {
      file: 'frontend/README.md',
      guards: ['node ../scripts/validate-npm-lock-registry.mjs package-lock.json'],
    },
  ]

  for (const { file, guards } of contracts) {
    const lines = readRepositoryFile(file).split(/\r?\n/u)
    const installIndexes = lines
      .map((line, index) => (/^\s*npm\s+(?:ci|install|i)\b/u.test(line) ? index : -1))
      .filter((index) => index >= 0)
    assert.equal(installIndexes.length, guards.length, `${file} npm install examples changed`)

    for (const [ordinal, installIndex] of installIndexes.entries()) {
      let fenceIndex = installIndex - 1
      while (fenceIndex >= 0 && !/^\s*```/u.test(lines[fenceIndex])) fenceIndex -= 1
      assert.ok(fenceIndex >= 0, `${file} install example is outside a fenced block`)
      assert.ok(
        lines.slice(fenceIndex + 1, installIndex).some((line) => line.trim() === guards[ordinal]),
        `${file} install example ${ordinal + 1} lacks guard: ${guards[ordinal]}`,
      )
    }
  }
})

test('the repository lockfiles contain only official registry URLs', () => {
  for (const lockfilePath of ['package-lock.json', 'frontend/package-lock.json']) {
    const lockfile = JSON.parse(readRepositoryFile(lockfilePath))
    const result = validateNpmLockRegistry(lockfile)
    assert.ok(result.resolvedCount > 0, `${lockfilePath} has no resolved URLs`)
    assert.deepEqual(result.errors, [], lockfilePath)
  }
})

test('the dependency inventory exporter rejects an untrusted lock before writing output', () => {
  const exporter = readRepositoryFile('scripts/export-npm-dependencies.mjs')
  assertOrdered(exporter, [
    ['lockfile read', "readFileSync(lockfilePath, 'utf8')"],
    ['registry validation', 'validateNpmLockRegistry(lockfile)'],
    ['inventory output', 'writeFileSync('],
  ])

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'npm inventory registry guard-'))
  const outputPath = join(temporaryDirectory, 'dependencies.json')
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'scripts', 'export-npm-dependencies.mjs'),
        join(
          REPOSITORY_ROOT,
          'tests',
          'fixtures',
          'npm-lock-registry',
          'malicious-package-lock.json',
        ),
        outputPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 1, output)
    assert.match(output, /Refusing to export dependencies from an untrusted npm lockfile/u)
    assert.match(output, /host must be registry\.npmjs\.org/u)
    assert.equal(existsSync(outputPath), false)
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})

test('the dependency inventory exporter accepts the official frontend lock', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'npm inventory official lock-'))
  const outputPath = join(temporaryDirectory, 'dependencies.json')
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'scripts', 'export-npm-dependencies.mjs'),
        join(REPOSITORY_ROOT, 'frontend', 'package-lock.json'),
        outputPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 0, output)
    assert.equal(existsSync(outputPath), true)

    const inventory = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(inventory.source, 'package-lock.json')
    assert.ok(inventory.packageCount > 0)
    assert.equal(inventory.packageCount, inventory.packages.length)
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})
