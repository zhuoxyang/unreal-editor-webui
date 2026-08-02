import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SUPPORTED_NODE_FLOORS = Object.freeze([
  Object.freeze({ major: 22, minor: 22, patch: 2 }),
  Object.freeze({ major: 24, minor: 18, patch: 1 }),
])

export const NODE_ENGINE_RANGE = SUPPORTED_NODE_FLOORS
  .map(({ major, minor, patch }) => `^${major}.${minor}.${patch}`)
  .join(' || ')

export function parseNodeVersion(rawVersion) {
  if (typeof rawVersion !== 'string') return null

  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(rawVersion)
  if (!match || match[0] !== rawVersion) return null

  const [major, minor, patch] = match.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch }
}

export function isSupportedNodeVersion(rawVersion) {
  const version = parseNodeVersion(rawVersion)
  if (!version) return false

  return SUPPORTED_NODE_FLOORS.some((floor) =>
    version.major === floor.major &&
    (version.minor > floor.minor ||
      (version.minor === floor.minor && version.patch >= floor.patch)),
  )
}

function runCli() {
  const nodeVersion = process.versions.node
  if (!isSupportedNodeVersion(nodeVersion)) {
    console.error(
      `Unsupported Node.js ${nodeVersion}. ` +
      `Expected ${NODE_ENGINE_RANGE} as declared by frontend/package.json.`,
    )
    process.exitCode = 1
    return
  }

  console.log(`Node.js ${nodeVersion} satisfies the frontend engine requirement (${NODE_ENGINE_RANGE}).`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli()
}
