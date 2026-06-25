export type ExecutionMode = 'run' | 'task'

export type RecentExecution = {
  id: string
  command: string
  mode: ExecutionMode
  payload: Record<string, unknown>
  ranAt: string
}

const RECENT_EXECUTIONS_STORAGE_KEY = 'unreal-editor-webui.recentExecutions'
export const MAX_RECENT_EXECUTIONS = 12

export function loadStoredRecentExecutions(): RecentExecution[] {
  try {
    const stored = globalThis.localStorage?.getItem(RECENT_EXECUTIONS_STORAGE_KEY)
    if (!stored) {
      return []
    }

    const parsed = JSON.parse(stored) as RecentExecution[]
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item) => item && typeof item.command === 'string' && typeof item.ranAt === 'string')
  } catch {
    return []
  }
}

export function saveStoredRecentExecutions(recentExecutions: RecentExecution[]) {
  try {
    globalThis.localStorage?.setItem(RECENT_EXECUTIONS_STORAGE_KEY, JSON.stringify(recentExecutions))
  } catch {
    // Local storage is optional in embedded browser contexts.
  }
}

export function formatRecentTime(value: string) {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleTimeString()
}
