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

export type ToolPackLoadedStatusV1 = {
  provider: string
  packId: string
  pluginName: string
  pluginVersion: string
  requiredCoreApi: number
  state: 'loaded'
  commandCount: number
  commands: string[]
}

export type ToolPackRejectedStatusV1 =
  | {
      provider: string
      packId: string
      pluginName: string
      pluginVersion: string
      requiredCoreApi: number
      state: 'rejected'
      commandCount: 0
      commands: []
    }
  | {
      provider: null
      packId: null
      pluginName: string
      pluginVersion: null
      requiredCoreApi: null
      state: 'rejected'
      commandCount: 0
      commands: []
    }

export type ToolPackStatusEntryV1 = ToolPackLoadedStatusV1 | ToolPackRejectedStatusV1

export type ToolPackStatusV1 = {
  statusVersion: 1
  coreApiVersion: number
  packs: ToolPackStatusEntryV1[]
  truncatedCount: number
}

export type ToolPackBackendReasonCode =
  | 'command_namespace_conflict'
  | 'command_registration_rejected'
  | 'dependency_hash_mismatch'
  | 'dependency_policy_invalid'
  | 'entry_import_failed'
  | 'entry_module_ambiguous'
  | 'entry_module_duplicate'
  | 'entry_module_invalid'
  | 'entry_module_missing'
  | 'entry_modules_invalid'
  | 'in_process_native_dependency_unsupported'
  | 'pack_id_conflict'
  | 'plugin_name_conflict'
  | 'python_package_conflict'
  | 'startup_hook_forbidden'
  | 'tool_pack_conflict'
  | 'trust_anchor_missing'
  | 'trust_policy_invalid'
  | 'trusted_core_api_mismatch'
  | 'trusted_pack_missing'
  | 'trusted_payload_mismatch'
  | 'trusted_payload_unverifiable'
  | 'trusted_plugin_version_mismatch'
  | 'undeclared_registration_origin'
  | 'unlocked_vendored_dependencies'
  | 'validation_failed'
  | 'vendored_dependencies_missing'

export type ToolPackStatusEntryV2 = ToolPackStatusEntryV1 & {
  reasonCodes: ToolPackBackendReasonCode[]
}

export type ToolPackPolicyStatusV2 =
  | { enforced: false; state: 'disabled'; reasonCodes: [] }
  | { enforced: true; state: 'accepted'; reasonCodes: [] }
  | { enforced: true; state: 'rejected'; reasonCodes: ToolPackBackendReasonCode[] }

export type ToolPackStatusV2 = {
  statusVersion: 2
  coreApiVersion: number
  policy: ToolPackPolicyStatusV2
  packs: ToolPackStatusEntryV2[]
  truncatedCount: number
}

export type ToolPackStatus = ToolPackStatusV1 | ToolPackStatusV2

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

