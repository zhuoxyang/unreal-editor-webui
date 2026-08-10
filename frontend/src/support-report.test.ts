import { describe, expect, it } from 'vitest'
import {
  MAX_SUPPORT_REPORT_BYTES,
  SUPPORT_REPORT_VERSION,
  buildSupportReport,
  stringifySupportReport,
  supportHealthSummary,
  type SupportReportInput,
} from './support-report'

const INPUT: SupportReportInput = {
  protocolVersion: 1,
  bridgeProtocolVersion: 1,
  pluginVersion: '0.1.1-rc.2',
  engineVersion: '5.8.0',
  documentScope: 'packaged',
  pythonRuntime: 'available',
  privilegedConfirmation: 'per_call',
  taskSessionIsolation: 'document',
  bridgeLifecycle: 'ready',
  bridgeDiagnosticCode: null,
  projectPersistenceStatus: 'enabled',
  registryStatus: 'ready',
  registryAvailableCount: 12,
  registryLoadErrorCount: 1,
  catalogStatus: 'fallback',
  catalogSource: 'starter',
  catalogSchemaVersion: 1,
  catalogDiagnosticCode: 'catalog_missing',
  queuedTaskCount: 1,
  runningTaskCount: 2,
  completedTaskCount: 3,
  failedTaskCount: 4,
  cancelledTaskCount: 5,
  timedOutTaskCount: 6,
}

describe('support report', () => {
  it('builds the exact scalar-only v1 schema and aggregate task total', () => {
    expect(buildSupportReport(INPUT)).toEqual({
      reportVersion: SUPPORT_REPORT_VERSION,
      product: 'unreal-editor-webui',
      health: {
        overallStatus: 'degraded',
        reasonCodes: [
          'health_registry_modules_rejected',
          'health_catalog_fallback',
        ],
      },
      native: {
        protocolVersion: 1,
        bridgeProtocolVersion: 1,
        pluginVersion: '0.1.1-rc.2',
        engineVersion: '5.8.0',
        documentScope: 'packaged',
        pythonRuntime: 'available',
        privilegedConfirmation: 'per_call',
        taskSessionIsolation: 'document',
      },
      bridge: {
        lifecycle: 'ready',
        diagnosticCode: null,
      },
      project: {
        persistence: 'enabled',
      },
      registry: {
        status: 'ready',
        availableCount: 12,
        loadErrorCount: 1,
      },
      catalog: {
        status: 'fallback',
        source: 'starter',
        schemaVersion: 1,
        diagnosticCode: 'catalog_missing',
      },
      tasks: {
        queued: 1,
        running: 2,
        completed: 3,
        failed: 4,
        cancelled: 5,
        timedOut: 6,
        total: 21,
      },
    })
  })

  it('uses the report health summary as the canonical aggregate', () => {
    const report = buildSupportReport(INPUT)
    const serialized = stringifySupportReport(INPUT)

    expect(supportHealthSummary(INPUT)).toEqual(report.health)
    expect(stringifySupportReport(INPUT)).toBe(serialized)
    expect(report.health).toEqual({
      overallStatus: 'degraded',
      reasonCodes: [
        'health_registry_modules_rejected',
        'health_catalog_fallback',
      ],
    })
  })

  it('keeps known degradation above pending checks while preserving deterministic reason order', () => {
    expect(supportHealthSummary({
      ...INPUT,
      pythonRuntime: 'unavailable',
      registryLoadErrorCount: 0,
      registryStatus: 'loading',
      catalogStatus: 'loading',
      catalogDiagnosticCode: null,
    })).toEqual({
      overallStatus: 'degraded',
      reasonCodes: [
        'health_python_unavailable',
        'health_registry_loading',
        'health_catalog_loading',
      ],
    })

    expect(supportHealthSummary({
      ...INPUT,
      registryLoadErrorCount: 0,
      registryStatus: 'loading',
      catalogStatus: 'loading',
      catalogDiagnosticCode: null,
    })).toEqual({
      overallStatus: 'checking',
      reasonCodes: [
        'health_registry_loading',
        'health_catalog_loading',
      ],
    })

    expect(supportHealthSummary({
      ...INPUT,
      documentScope: 'inactive',
      registryLoadErrorCount: 0,
      registryStatus: 'loading',
      catalogStatus: 'loading',
      catalogDiagnosticCode: null,
    }).overallStatus).toBe('unhealthy')

    expect(supportHealthSummary({
      ...INPUT,
      protocolVersion: null,
      registryLoadErrorCount: 0,
      registryStatus: 'loading',
      catalogStatus: 'loading',
      catalogDiagnosticCode: null,
    }).overallStatus).toBe('error')
  })

  it('redacts invalid dynamic strings, ignores extra raw fields, and normalizes unsafe scalars', () => {
    const secretPath = 'C:/Users/private/project'
    const secretUrl = 'https://localhost:5173/?token=do-not-copy'
    const projectName = 'private-project-name'
    const storageNamespace = 'project-private-storage-fingerprint'
    const requestId = 'request-private-identifier'
    const browserSessionId = 'browser-private-session'
    const documentSessionId = 'document-private-session'
    const taskId = 'task-private-identifier'
    const stackTrace = 'private-stack-trace'
    const credential = 'private-credential-value'
    const rawInput = {
      ...INPUT,
      pluginVersion: `0.1.1_${secretPath}`,
      engineVersion: secretPath,
      bridgeLifecycle: 'unexpected-secret-state',
      bridgeDiagnosticCode: `native-${secretPath}`,
      catalogDiagnosticCode: `catalog-${secretPath}`,
      registryAvailableCount: -42,
      runningTaskCount: Number.NaN,
      resolvedUrl: secretUrl,
      projectName,
      storageNamespace,
      requestId,
      browserSessionId,
      documentSessionId,
      taskId,
      stackTrace,
      settings: { startupUrl: secretUrl, credential },
      logs: [`failed at ${secretPath}`],
    } as unknown as SupportReportInput

    const text = stringifySupportReport(rawInput)
    const report = JSON.parse(text) as Record<string, unknown>
    expect(text).not.toContain(secretPath)
    expect(text).not.toContain(secretUrl)
    expect(text).not.toContain('do-not-copy')
    for (const canary of [
      projectName,
      storageNamespace,
      requestId,
      browserSessionId,
      documentSessionId,
      taskId,
      stackTrace,
      credential,
    ]) {
      expect(text).not.toContain(canary)
    }
    expect(report.native).toMatchObject({
      pluginVersion: null,
      engineVersion: null,
      documentScope: null,
      pythonRuntime: null,
    })
    expect(report.bridge).toEqual({
      lifecycle: 'error',
      diagnosticCode: 'health_request_failed',
    })
    expect(report.health).toEqual({
      overallStatus: 'error',
      reasonCodes: ['health_request_failed'],
    })
    expect(report.registry).toMatchObject({ availableCount: 0 })
    expect(report.tasks).toMatchObject({ running: 0 })
  })

  it('drops stale native fields unless the bridge lifecycle is ready', () => {
    const report = buildSupportReport({
      ...INPUT,
      bridgeLifecycle: 'error',
      bridgeDiagnosticCode: 'health_transport_invalid',
    })

    expect(report.native).toEqual({
      protocolVersion: null,
      bridgeProtocolVersion: null,
      pluginVersion: null,
      engineVersion: null,
      documentScope: null,
      pythonRuntime: null,
      privilegedConfirmation: null,
      taskSessionIsolation: null,
    })
    expect(report.bridge).toEqual({
      lifecycle: 'error',
      diagnosticCode: 'health_transport_invalid',
    })
    expect(report.health).toEqual({
      overallStatus: 'error',
      reasonCodes: ['health_transport_invalid'],
    })
  })

  it('serializes below the hard 4 KiB UTF-8 cap even at maximum dynamic version lengths', () => {
    const text = stringifySupportReport({
      ...INPUT,
      pluginVersion: 'A'.repeat(64),
      engineVersion: '123456789.123456789.123456789',
    })

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_SUPPORT_REPORT_BYTES)
    expect(JSON.parse(text)).toMatchObject({
      reportVersion: 1,
      product: 'unreal-editor-webui',
    })
  })
})
