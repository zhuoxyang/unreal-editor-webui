export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

export type ChangeSetOperationStatus = 'skipped' | 'failed' | 'changed' | 'changed_unsaved'

export type ChangeSetErrorOperation = {
  assetPath: string
  propertyPath: string
  before: unknown
  after: unknown
  action: string
  status: ChangeSetOperationStatus
  message: string
}

export type ChangeSetErrorData = {
  protocolVersion: 1
  view: 'changeSet'
  summary: {
    label: string
    dryRun: boolean
    save: boolean
    status: 'preview' | 'partial' | 'failed' | 'completed' | 'no_changes'
    changed: number
    changedUnsaved: number
    skipped: number
    failed: number
    total: number
  }
  changeSet: ChangeSetErrorOperation[]
}

export type BridgeErrorData = ChangeSetErrorData

export type BridgeResponse<T> =
  | {
      id: string | null
      ok: true
      result: T
    }
  | {
      id: string | null
      ok: false
      error: {
        code: string
        message: string
        details?: string[]
        data?: BridgeErrorData
        traceback?: string
      }
    }

export type TaskResult = {
  taskId: string
  status: TaskStatus
  command?: string
  payload?: Record<string, unknown>
  progress?: number
  cancellable?: boolean
  cancellationMode?: string
  executionThread?: string
  timeoutPolicy?: string
  message?: string
  logs?: string[]
  createdAt?: string
  updatedAt?: string
  responseJson?: string
}

export type WebUISettings = {
  useDevServer: boolean
  devServerUrl: string
  startupUrl: string
  resolvedUrl: string
}

export type ProjectContext = {
  protocolVersion: 1
  projectName: string
  storageNamespace: string
}

