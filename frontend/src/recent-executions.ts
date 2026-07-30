import {
  isRecord,
  storedEnvelope,
  type StorageLoadResult,
} from './storage'

export type ExecutionMode = 'run' | 'task'

export type RecentExecution = {
  id: string
  command: string
  mode: ExecutionMode
  payload: Record<string, unknown>
  ranAt: string
}

export const RECENT_EXECUTIONS_STORAGE_KEY = 'unreal-editor-webui.recentExecutions'
export const RECENT_EXECUTIONS_SCHEMA_VERSION = 1
export const MAX_RECENT_EXECUTIONS = 12

function isRecentExecution(value: unknown): value is RecentExecution {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.command === 'string' &&
    value.command.trim().length > 0 &&
    (value.mode === 'run' || value.mode === 'task') &&
    isRecord(value.payload) &&
    typeof value.ranAt === 'string' &&
    Number.isFinite(Date.parse(value.ranAt))
  )
}

export function normalizeRecentExecutions(value: unknown): RecentExecution[] {
  if (!Array.isArray(value)) {
    return []
  }

  const ids = new Set<string>()
  const normalized: RecentExecution[] = []
  for (const item of value) {
    if (!isRecentExecution(item) || ids.has(item.id)) {
      continue
    }

    ids.add(item.id)
    normalized.push({
      id: item.id,
      command: item.command,
      mode: item.mode,
      payload: { ...item.payload },
      ranAt: item.ranAt,
    })
    if (normalized.length >= MAX_RECENT_EXECUTIONS) {
      break
    }
  }
  return normalized
}

export function loadStoredRecentExecutionsState(): StorageLoadResult<RecentExecution[]> {
  try {
    const stored = globalThis.localStorage?.getItem(RECENT_EXECUTIONS_STORAGE_KEY)
    if (!stored) {
      return { value: [], needsRewrite: false, source: 'missing' }
    }

    const parsed: unknown = JSON.parse(stored)
    if (Array.isArray(parsed)) {
      return {
        value: normalizeRecentExecutions(parsed),
        needsRewrite: true,
        source: 'legacy',
      }
    }

    if (isRecord(parsed) && parsed.schemaVersion === RECENT_EXECUTIONS_SCHEMA_VERSION) {
      if (!Array.isArray(parsed.data)) {
        return { value: [], needsRewrite: true, source: 'invalid' }
      }
      const value = normalizeRecentExecutions(parsed.data)
      return {
        value,
        needsRewrite: JSON.stringify(value) !== JSON.stringify(parsed.data),
        source: 'current',
      }
    }

    if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')) {
      return { value: [], needsRewrite: false, source: 'unsupported' }
    }
    return { value: [], needsRewrite: true, source: 'invalid' }
  } catch {
    return { value: [], needsRewrite: true, source: 'invalid' }
  }
}

export function loadStoredRecentExecutions(): RecentExecution[] {
  return loadStoredRecentExecutionsState().value
}

export function saveStoredRecentExecutions(recentExecutions: RecentExecution[]) {
  try {
    const normalized = normalizeRecentExecutions(recentExecutions)
    globalThis.localStorage?.setItem(
      RECENT_EXECUTIONS_STORAGE_KEY,
      JSON.stringify(storedEnvelope(RECENT_EXECUTIONS_SCHEMA_VERSION, normalized)),
    )
  } catch {
    // Local storage is optional in embedded browser contexts.
  }
}

export function cloneExecutionPayload(payload: Record<string, unknown>) {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(payload))
    return isRecord(cloned) ? cloned : {}
  } catch {
    return {}
  }
}

export function formatRecentTime(value: string) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleTimeString()
}
