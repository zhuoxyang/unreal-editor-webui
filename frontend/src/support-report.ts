import type { CommandsLoadStatus } from './hooks/useCommands'
import type {
  ToolCatalogDiagnosticCode,
  ToolCatalogLoadStatus,
  ToolCatalogSource,
} from './hooks/useToolCatalog'
import type { WebUIHealthDiagnosticCode, WebUIHealthStatus } from './hooks/useWebUIHealth'
import type { WebUIDocumentScope, WebUIPythonRuntime } from './types/bridge'

export const SUPPORT_REPORT_VERSION = 1 as const
export const MAX_SUPPORT_REPORT_BYTES = 4 * 1024

const MAX_SUPPORT_COUNT = 1_000_000
const CANONICAL_PLUGIN_VERSION = /^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/
const CANONICAL_ENGINE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const WEB_UI_HEALTH_STATUSES = new Set<WebUIHealthStatus>([
  'unavailable',
  'unsupported',
  'loading',
  'ready',
  'error',
])
const WEB_UI_HEALTH_DIAGNOSTIC_CODES = new Set<WebUIHealthDiagnosticCode>([
  'health_bridge_unavailable',
  'health_method_unavailable',
  'health_transport_invalid',
  'health_request_failed',
])
const DOCUMENT_SCOPES = new Set<WebUIDocumentScope>([
  'packaged',
  'loopback_http',
  'loopback_https',
  'inactive',
])
const PYTHON_RUNTIMES = new Set<WebUIPythonRuntime>(['available', 'unavailable'])
const PROJECT_PERSISTENCE_STATUSES = new Set<ProjectPersistenceStatus>(['loading', 'enabled', 'disabled'])
const REGISTRY_STATUSES = new Set<CommandsLoadStatus>(['idle', 'loading', 'ready', 'error'])
const CATALOG_STATUSES = new Set<ToolCatalogLoadStatus>(['loading', 'ready', 'fallback'])
const CATALOG_SOURCES = new Set<ToolCatalogSource>(['project', 'starter'])
const CATALOG_DIAGNOSTIC_CODES = new Set<ToolCatalogDiagnosticCode>([
  'catalog_too_large',
  'catalog_read_failed',
  'catalog_invalid_json',
  'catalog_invalid_encoding',
  'catalog_resource_limit',
  'catalog_invalid_schema_version',
  'catalog_unsupported_version',
  'catalog_missing',
  'catalog_bridge_unavailable',
  'catalog_schema_unsupported',
  'catalog_schema_invalid',
  'catalog_transport_invalid',
  'catalog_load_failed',
])

export type ProjectPersistenceStatus = 'loading' | 'enabled' | 'disabled'

export type SupportHealthOverallStatus =
  | 'unavailable'
  | 'unsupported'
  | 'checking'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'error'

export type SupportHealthReasonCode =
  | WebUIHealthDiagnosticCode
  | 'health_bridge_checking'
  | 'health_native_context_invalid'
  | 'health_document_inactive'
  | 'health_python_unavailable'
  | 'health_project_persistence_loading'
  | 'health_project_persistence_unavailable'
  | 'health_registry_loading'
  | 'health_registry_unavailable'
  | 'health_registry_modules_rejected'
  | 'health_catalog_loading'
  | 'health_catalog_fallback'

export type SupportReportInput = {
  protocolVersion: 1 | null
  bridgeProtocolVersion: 1 | null
  pluginVersion: string | null
  engineVersion: string | null
  documentScope: WebUIDocumentScope | null
  pythonRuntime: WebUIPythonRuntime | null
  privilegedConfirmation: 'per_call' | null
  taskSessionIsolation: 'document' | null
  bridgeLifecycle: WebUIHealthStatus
  bridgeDiagnosticCode: WebUIHealthDiagnosticCode | null
  projectPersistenceStatus: ProjectPersistenceStatus
  registryStatus: CommandsLoadStatus
  registryAvailableCount: number
  registryLoadErrorCount: number
  catalogStatus: ToolCatalogLoadStatus
  catalogSource: ToolCatalogSource
  catalogSchemaVersion: 1
  catalogDiagnosticCode: ToolCatalogDiagnosticCode | null
  queuedTaskCount: number
  runningTaskCount: number
  completedTaskCount: number
  failedTaskCount: number
  cancelledTaskCount: number
  timedOutTaskCount: number
}

export type SupportReportV1 = {
  reportVersion: 1
  product: 'unreal-editor-webui'
  health: {
    overallStatus: SupportHealthOverallStatus
    reasonCodes: SupportHealthReasonCode[]
  }
  native: {
    protocolVersion: 1 | null
    bridgeProtocolVersion: 1 | null
    pluginVersion: string | null
    engineVersion: string | null
    documentScope: WebUIDocumentScope | null
    pythonRuntime: WebUIPythonRuntime | null
    privilegedConfirmation: 'per_call' | null
    taskSessionIsolation: 'document' | null
  }
  bridge: {
    lifecycle: WebUIHealthStatus
    diagnosticCode: WebUIHealthDiagnosticCode | null
  }
  project: {
    persistence: ProjectPersistenceStatus
  }
  registry: {
    status: CommandsLoadStatus
    availableCount: number
    loadErrorCount: number
  }
  catalog: {
    status: ToolCatalogLoadStatus
    source: ToolCatalogSource
    schemaVersion: 1
    diagnosticCode: ToolCatalogDiagnosticCode | null
  }
  tasks: {
    queued: number
    running: number
    completed: number
    failed: number
    cancelled: number
    timedOut: number
    total: number
  }
}

export type SupportHealthSummary = SupportReportV1['health']

function deriveSupportHealth(
  native: SupportReportV1['native'],
  bridge: SupportReportV1['bridge'],
  project: SupportReportV1['project'],
  registry: SupportReportV1['registry'],
  catalog: SupportReportV1['catalog'],
): SupportHealthSummary {
  const reasonCodes: SupportHealthReasonCode[] = []
  if (bridge.lifecycle === 'unavailable') reasonCodes.push('health_bridge_unavailable')
  if (bridge.lifecycle === 'unsupported') reasonCodes.push('health_method_unavailable')
  if (bridge.lifecycle === 'loading') reasonCodes.push('health_bridge_checking')
  if (bridge.lifecycle === 'error') {
    reasonCodes.push(bridge.diagnosticCode || 'health_request_failed')
  }

  if (bridge.lifecycle === 'ready') {
    if (
      native.protocolVersion !== 1
      || native.bridgeProtocolVersion !== 1
      || !native.pluginVersion
      || !native.engineVersion
      || !native.documentScope
      || !native.pythonRuntime
      || native.privilegedConfirmation !== 'per_call'
      || native.taskSessionIsolation !== 'document'
    ) {
      reasonCodes.push('health_native_context_invalid')
    }
    if (native.documentScope === 'inactive') reasonCodes.push('health_document_inactive')
    if (native.pythonRuntime === 'unavailable') reasonCodes.push('health_python_unavailable')
    if (project.persistence === 'loading') reasonCodes.push('health_project_persistence_loading')
    if (project.persistence === 'disabled') reasonCodes.push('health_project_persistence_unavailable')
    if (registry.status === 'idle' || registry.status === 'loading') reasonCodes.push('health_registry_loading')
    if (registry.status === 'error') reasonCodes.push('health_registry_unavailable')
    if (registry.loadErrorCount > 0) reasonCodes.push('health_registry_modules_rejected')
    if (catalog.status === 'loading') reasonCodes.push('health_catalog_loading')
    if (catalog.status === 'fallback') reasonCodes.push('health_catalog_fallback')
  }

  let overallStatus: SupportHealthOverallStatus = 'healthy'
  if (bridge.lifecycle === 'unavailable') overallStatus = 'unavailable'
  else if (bridge.lifecycle === 'unsupported') overallStatus = 'unsupported'
  else if (bridge.lifecycle === 'loading') overallStatus = 'checking'
  else if (bridge.lifecycle === 'error') overallStatus = 'error'
  else if (reasonCodes.includes('health_native_context_invalid')) overallStatus = 'error'
  else if (reasonCodes.includes('health_document_inactive')) overallStatus = 'unhealthy'
  else if (reasonCodes.some((code) => (
    code !== 'health_project_persistence_loading'
    && code !== 'health_registry_loading'
    && code !== 'health_catalog_loading'
  ))) overallStatus = 'degraded'
  else if (reasonCodes.length > 0) overallStatus = 'checking'

  return { overallStatus, reasonCodes }
}

export class SupportReportSizeError extends Error {
  constructor() {
    super(`Support report exceeds the ${MAX_SUPPORT_REPORT_BYTES}-byte limit.`)
    this.name = 'SupportReportSizeError'
  }
}

function safeCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) return 0
  return Math.min(value, MAX_SUPPORT_COUNT)
}

function safePluginVersion(value: string | null) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && CANONICAL_PLUGIN_VERSION.test(value)
    ? value
    : null
}

function safeEngineVersion(value: string | null) {
  return typeof value === 'string'
    && value.length <= 32
    && CANONICAL_ENGINE_VERSION.test(value)
    ? value
    : null
}

function safeHealthStatus(value: WebUIHealthStatus) {
  return WEB_UI_HEALTH_STATUSES.has(value) ? value : 'error'
}

function safeHealthDiagnostic(
  lifecycle: WebUIHealthStatus,
  value: WebUIHealthDiagnosticCode | null,
): WebUIHealthDiagnosticCode | null {
  if (lifecycle === 'ready' || lifecycle === 'loading') return null
  if (lifecycle === 'unavailable') return 'health_bridge_unavailable'
  if (lifecycle === 'unsupported') return 'health_method_unavailable'
  return value && WEB_UI_HEALTH_DIAGNOSTIC_CODES.has(value) ? value : 'health_request_failed'
}

function safeCatalogDiagnostic(
  status: ToolCatalogLoadStatus,
  value: ToolCatalogDiagnosticCode | null,
): ToolCatalogDiagnosticCode | null {
  if (status !== 'fallback') return null
  return value && CATALOG_DIAGNOSTIC_CODES.has(value) ? value : 'catalog_load_failed'
}

export function buildSupportReport(input: SupportReportInput): SupportReportV1 {
  const bridgeLifecycle = safeHealthStatus(input.bridgeLifecycle)
  const includeNativeHealth = bridgeLifecycle === 'ready'
  const documentScope = includeNativeHealth && input.documentScope && DOCUMENT_SCOPES.has(input.documentScope)
    ? input.documentScope
    : null
  const pythonRuntime = includeNativeHealth && input.pythonRuntime && PYTHON_RUNTIMES.has(input.pythonRuntime)
    ? input.pythonRuntime
    : null
  const projectPersistence = PROJECT_PERSISTENCE_STATUSES.has(input.projectPersistenceStatus)
    ? input.projectPersistenceStatus
    : 'disabled'
  const registryStatus = REGISTRY_STATUSES.has(input.registryStatus) ? input.registryStatus : 'error'
  const catalogStatus = CATALOG_STATUSES.has(input.catalogStatus) ? input.catalogStatus : 'fallback'
  const catalogSource = CATALOG_SOURCES.has(input.catalogSource) ? input.catalogSource : 'starter'
  const queued = safeCount(input.queuedTaskCount)
  const running = safeCount(input.runningTaskCount)
  const completed = safeCount(input.completedTaskCount)
  const failed = safeCount(input.failedTaskCount)
  const cancelled = safeCount(input.cancelledTaskCount)
  const timedOut = safeCount(input.timedOutTaskCount)

  const native: SupportReportV1['native'] = {
    protocolVersion: includeNativeHealth && input.protocolVersion === 1 ? 1 : null,
    bridgeProtocolVersion: includeNativeHealth && input.bridgeProtocolVersion === 1 ? 1 : null,
    pluginVersion: includeNativeHealth ? safePluginVersion(input.pluginVersion) : null,
    engineVersion: includeNativeHealth ? safeEngineVersion(input.engineVersion) : null,
    documentScope,
    pythonRuntime,
    privilegedConfirmation: includeNativeHealth && input.privilegedConfirmation === 'per_call' ? 'per_call' : null,
    taskSessionIsolation: includeNativeHealth && input.taskSessionIsolation === 'document' ? 'document' : null,
  }
  const bridge: SupportReportV1['bridge'] = {
    lifecycle: bridgeLifecycle,
    diagnosticCode: safeHealthDiagnostic(bridgeLifecycle, input.bridgeDiagnosticCode),
  }
  const project: SupportReportV1['project'] = {
    persistence: projectPersistence,
  }
  const registry: SupportReportV1['registry'] = {
    status: registryStatus,
    availableCount: safeCount(input.registryAvailableCount),
    loadErrorCount: safeCount(input.registryLoadErrorCount),
  }
  const catalog: SupportReportV1['catalog'] = {
    status: catalogStatus,
    source: catalogSource,
    schemaVersion: 1,
    diagnosticCode: safeCatalogDiagnostic(catalogStatus, input.catalogDiagnosticCode),
  }
  const tasks: SupportReportV1['tasks'] = {
    queued,
    running,
    completed,
    failed,
    cancelled,
    timedOut,
    total: queued + running + completed + failed + cancelled + timedOut,
  }

  return {
    reportVersion: SUPPORT_REPORT_VERSION,
    product: 'unreal-editor-webui',
    health: deriveSupportHealth(native, bridge, project, registry, catalog),
    native,
    bridge,
    project,
    registry,
    catalog,
    tasks,
  }
}

export function supportHealthSummary(input: SupportReportInput): SupportHealthSummary {
  return buildSupportReport(input).health
}

export function stringifySupportReport(input: SupportReportInput) {
  const text = JSON.stringify(buildSupportReport(input), null, 2)
  if (new TextEncoder().encode(text).byteLength > MAX_SUPPORT_REPORT_BYTES) {
    throw new SupportReportSizeError()
  }
  return text
}
