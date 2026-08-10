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

export type WebUIDocumentScope = 'packaged' | 'loopback_http' | 'loopback_https' | 'inactive'

export type WebUIPythonRuntime = 'available' | 'unavailable'

export type WebUIHealth = {
  protocolVersion: 1
  bridgeProtocolVersion: 1
  pluginVersion: string
  engineVersion: string
  documentScope: WebUIDocumentScope
  pythonRuntime: WebUIPythonRuntime
  privilegedConfirmation: 'per_call'
  taskSessionIsolation: 'document'
}

export type NativeToolCatalogDiagnosticCode =
  | 'catalog_too_large'
  | 'catalog_read_failed'
  | 'catalog_invalid_json'
  | 'catalog_invalid_encoding'
  | 'catalog_resource_limit'
  | 'catalog_invalid_schema_version'
  | 'catalog_unsupported_version'

export type ToolCatalogBridgeResult =
  | {
      protocolVersion: 1
      source: 'project'
      catalog: Record<string, unknown>
      diagnosticCode: null
    }
  | {
      protocolVersion: 1
      source: 'missing'
      catalog: null
      diagnosticCode: null
    }
  | {
      protocolVersion: 1
      source: 'invalid'
      catalog: null
      diagnosticCode: NativeToolCatalogDiagnosticCode
    }

