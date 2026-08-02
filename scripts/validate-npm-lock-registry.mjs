import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OFFICIAL_REGISTRY_HOST = 'registry.npmjs.org'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateResolvedUrl(resolved) {
  let url
  try {
    url = new URL(resolved)
  } catch {
    return 'resolved URL is invalid'
  }

  if (url.protocol !== 'https:') return 'resolved URL must use HTTPS'
  if (url.hostname !== OFFICIAL_REGISTRY_HOST) {
    return `resolved URL host must be ${OFFICIAL_REGISTRY_HOST}`
  }
  if (url.username || url.password) return 'resolved URL must not contain credentials'
  if (url.port) return 'resolved URL must not use a non-default port'
  if (url.search || url.hash) return 'resolved URL must not contain a query or fragment'
  if (!url.pathname.endsWith('.tgz')) return 'resolved URL must identify a registry tarball'
  return null
}

export function validateNpmLockRegistry(lockfile) {
  if (!isRecord(lockfile)) {
    return { errors: ['lockfile root must be an object'], resolvedCount: 0 }
  }
  if (!isRecord(lockfile.packages)) {
    return { errors: ['lockfile packages must be an object'], resolvedCount: 0 }
  }

  const errors = []
  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (!isRecord(entry)) {
      errors.push(`${packagePath || '<root>'}: package entry must be an object`)
    }
  }

  let resolvedCount = 0
  const pending = [{ path: 'lockfile', value: lockfile }]
  const visited = new WeakSet()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current.value !== 'object' || current.value === null) continue
    if (visited.has(current.value)) continue
    visited.add(current.value)

    for (const [key, value] of Object.entries(current.value)) {
      const path = Array.isArray(current.value)
        ? `${current.path}[${key}]`
        : `${current.path}.${key}`
      if (key !== 'resolved') {
        if (typeof value === 'object' && value !== null) pending.push({ path, value })
        continue
      }

      resolvedCount += 1
      if (typeof value !== 'string') {
        errors.push(`${path}: resolved URL must be a string`)
        continue
      }
      const reason = validateResolvedUrl(value)
      if (reason) errors.push(`${path}: ${reason}`)
    }
  }

  if (resolvedCount === 0) errors.push('lockfile must contain at least one resolved package URL')
  return { errors, resolvedCount }
}

function runCli() {
  const lockfilePath = process.argv[2]
  if (!lockfilePath) {
    console.error('Usage: node scripts/validate-npm-lock-registry.mjs <package-lock.json>')
    process.exitCode = 2
    return
  }

  let lockfile
  try {
    lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'))
  } catch (error) {
    console.error(`Unable to read npm lockfile: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }

  const { errors, resolvedCount } = validateNpmLockRegistry(lockfile)
  if (errors.length > 0) {
    console.error(`npm lockfile registry validation failed (${errors.length} error(s)):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log(`Validated ${resolvedCount} npm lockfile URLs against ${OFFICIAL_REGISTRY_HOST}.`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli()
}
