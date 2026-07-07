import type { TaskStatus } from './types/bridge'
export type { TaskRecord, WebUIEvent } from './types/task'

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
