#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import { validateNpmLockRegistry } from './validate-npm-lock-registry.mjs'

const [lockfilePath, outputPath] = process.argv.slice(2)
if (!lockfilePath || !outputPath) {
  console.error('Usage: node scripts/export-npm-dependencies.mjs <package-lock.json> <output.json>')
  process.exit(1)
}

const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
const registryValidation = validateNpmLockRegistry(lockfile)
if (registryValidation.errors.length > 0) {
  throw new Error(
    `Refusing to export dependencies from an untrusted npm lockfile:\n${registryValidation.errors
      .map((error) => `- ${error}`)
      .join('\n')}`,
  )
}
if (!lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
  throw new Error('Expected an npm package-lock file with a packages object.')
}

function packageName(packagePath, metadata) {
  if (typeof metadata.name === 'string' && metadata.name) {
    return metadata.name
  }

  return packagePath.split('node_modules/').at(-1)
}

const packages = Object.entries(lockfile.packages)
  .filter(([packagePath]) => packagePath !== '')
  .map(([packagePath, metadata]) => ({
    name: packageName(packagePath, metadata),
    version: metadata.version ?? null,
    path: packagePath,
    development: metadata.dev === true,
    optional: metadata.optional === true,
    license: metadata.license ?? null,
    resolved: metadata.resolved ?? null,
    integrity: metadata.integrity ?? null,
  }))
  .sort((left, right) =>
    `${left.name}\0${left.version}\0${left.path}`.localeCompare(
      `${right.name}\0${right.version}\0${right.path}`,
    ),
  )

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: basename(lockfilePath),
      lockfileVersion: lockfile.lockfileVersion ?? null,
      packageCount: packages.length,
      packages,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`Wrote ${packages.length} locked npm dependencies to ${outputPath}.`)
