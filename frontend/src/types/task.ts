import type { TaskResult } from './bridge'

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
