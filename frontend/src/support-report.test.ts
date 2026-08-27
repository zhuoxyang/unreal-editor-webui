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
  toolPackStatus: 'ready',
  toolPackDiagnosticCode: null,
  toolPackStatusVersion: 1,
  toolPackCoreApiVersion: 1,
  toolPackLoadedCount: 2,
  toolPackRejectedCount: 0,
  toolPackTruncatedCount: 0,
  toolPackReasonCodes: [],
  queuedTaskCount: 1,
  runningTaskCount: 2,
  completedTaskCount: 3,
  failedTaskCount: 4,
  cancelledTaskCount: 5,
  timedOutTaskCount: 6,
}

describe('support report', () => {
  it('builds the exact aggregate-only v2 schema and task total', () => {
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
      toolPacks: {
        status: 'ready',
        diagnosticCode: null,
        statusVersion: 1,
        coreApiVersion: 1,
        loadedCount: 2,
        rejectedCount: 0,
        truncatedCount: 0,
        reasonCodes: [],
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
    const packId = 'private.pack-identity'
    const packCommand = 'private.commandIdentity'
    const packPlugin = 'PrivateToolPackPlugin'
    const rawInput = {
      ...INPUT,
      pluginVersion: `0.1.1_${secretPath}`,
      engineVersion: secretPath,
      bridgeLifecycle: 'unexpected-secret-state',
      bridgeDiagnosticCode: `native-${secretPath}`,
      catalogDiagnosticCode: `catalog-${secretPath}`,
      toolPackStatus: 'unexpected-secret-state',
      toolPackDiagnosticCode: `tool-pack-${secretPath}`,
      toolPackStatusVersion: 99,
      toolPackCoreApiVersion: Number.NaN,
      toolPackLoadedCount: -8,
      toolPackRejectedCount: Number.NaN,
      toolPackTruncatedCount: -1,
      toolPackReasonCodes: [`reason-${secretPath}`],
      toolPackPacks: [{ packId, pluginName: packPlugin, commands: [packCommand] }],
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
      packId,
      packCommand,
      packPlugin,
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
    expect(report.toolPacks).toEqual({
      status: 'error',
      diagnosticCode: 'tool_pack_request_failed',
      statusVersion: null,
      coreApiVersion: null,
      loadedCount: 0,
      rejectedCount: 0,
      truncatedCount: 0,
      reasonCodes: [],
    })
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

  it('normalizes Tool Pack lifecycle diagnostics and fixed reason-code order', () => {
    expect(buildSupportReport({
      ...INPUT,
      toolPackStatus: 'unsupported',
      toolPackDiagnosticCode: 'tool_pack_schema_unsupported',
    }).toolPacks).toEqual({
      status: 'unsupported',
      diagnosticCode: 'tool_pack_schema_unsupported',
      statusVersion: null,
      coreApiVersion: null,
      loadedCount: 0,
      rejectedCount: 0,
      truncatedCount: 0,
      reasonCodes: [],
    })

    expect(buildSupportReport({
      ...INPUT,
      toolPackRejectedCount: 2,
      toolPackTruncatedCount: 3,
      toolPackReasonCodes: [
        'tool_pack_status_truncated',
        'tool_pack_load_rejected',
        'tool_pack_core_api_mismatch',
        'tool_pack_load_rejected',
      ],
    }).toolPacks.reasonCodes).toEqual([
      'tool_pack_core_api_mismatch',
      'tool_pack_load_rejected',
      'tool_pack_status_truncated',
    ])
  })

  it('integrates closed Tool Pack lifecycle and aggregate reasons into overall health', () => {
    const healthy: SupportReportInput = {
      ...INPUT,
      registryLoadErrorCount: 0,
      catalogStatus: 'ready',
      catalogSource: 'project',
      catalogDiagnosticCode: null,
    }

    expect(supportHealthSummary({
      ...healthy,
      toolPackStatus: 'loading',
      toolPackStatusVersion: null,
      toolPackCoreApiVersion: null,
    })).toEqual({
      overallStatus: 'checking',
      reasonCodes: ['health_tool_packs_loading'],
    })

    for (const status of ['unavailable', 'unsupported', 'malformed', 'error'] as const) {
      expect(supportHealthSummary({
        ...healthy,
        toolPackStatus: status,
        toolPackStatusVersion: null,
        toolPackCoreApiVersion: null,
      }), status).toEqual({
        overallStatus: 'degraded',
        reasonCodes: ['health_tool_packs_unavailable'],
      })
    }

    expect(supportHealthSummary({
      ...healthy,
      toolPackRejectedCount: 2,
      toolPackReasonCodes: ['tool_pack_load_rejected'],
    })).toEqual({
      overallStatus: 'degraded',
      reasonCodes: ['health_tool_packs_rejected'],
    })
    expect(supportHealthSummary({
      ...healthy,
      toolPackTruncatedCount: 5,
      toolPackReasonCodes: ['tool_pack_status_truncated'],
    })).toEqual({
      overallStatus: 'degraded',
      reasonCodes: ['health_tool_packs_truncated'],
    })
    expect(supportHealthSummary({
      ...healthy,
      bridgeLifecycle: 'unavailable',
      bridgeDiagnosticCode: 'health_bridge_unavailable',
      toolPackStatus: 'error',
      toolPackDiagnosticCode: 'tool_pack_request_failed',
    })).toEqual({
      overallStatus: 'unavailable',
      reasonCodes: ['health_bridge_unavailable'],
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
      reportVersion: 2,
      product: 'unreal-editor-webui',
    })
  })
})
