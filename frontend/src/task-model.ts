import type { TaskResult, TaskStatus } from './bridge'

export type WebUIEvent = {
  type: string
  taskId?: string
  status?: string
  progress?: number
  cancellable?: boolean
  cancellationMode?: string
  executionThread?: string
  timeoutPolicy?: string
  message?: string
  log?: string
  updatedAt?: string
  responseJson?: string
}

export type TaskRecord = TaskResult & {
  command: string
  payload: Record<string, unknown>
  startedAt: string
  lastError?: string
}

export function isTerminalTaskStatus(status: TaskStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out'
}

export function parseTaskStatus(status: string | undefined): TaskStatus | null {
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out'
  ) {
    return status
  }

  return null
}
