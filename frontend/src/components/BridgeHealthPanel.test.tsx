import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportHealthSummary, type SupportReportInput } from '../support-report'
import type { WebUIHealth } from '../types/bridge'
import { BridgeHealthPanel } from './BridgeHealthPanel'

const HEALTH: WebUIHealth = {
  protocolVersion: 1,
  bridgeProtocolVersion: 1,
  pluginVersion: '0.1.1',
  engineVersion: '5.8.0',
  documentScope: 'packaged',
  pythonRuntime: 'available',
  privilegedConfirmation: 'per_call',
  taskSessionIsolation: 'document',
}

const REPORT_INPUT: SupportReportInput = {
  protocolVersion: 1,
  bridgeProtocolVersion: 1,
  pluginVersion: '0.1.1',
  engineVersion: '5.8.0',
  documentScope: 'packaged',
  pythonRuntime: 'available',
  privilegedConfirmation: 'per_call',
  taskSessionIsolation: 'document',
  bridgeLifecycle: 'ready',
  bridgeDiagnosticCode: null,
  projectPersistenceStatus: 'enabled',
  registryStatus: 'ready',
  registryAvailableCount: 8,
  registryLoadErrorCount: 0,
  catalogStatus: 'ready',
  catalogSource: 'project',
  catalogSchemaVersion: 1,
  catalogDiagnosticCode: null,
  toolPackStatus: 'ready',
  toolPackDiagnosticCode: null,
  toolPackStatusVersion: 1,
  toolPackCoreApiVersion: 1,
  toolPackLoadedCount: 0,
  toolPackRejectedCount: 0,
  toolPackTruncatedCount: 0,
  toolPackReasonCodes: [],
  queuedTaskCount: 0,
  runningTaskCount: 1,
  completedTaskCount: 2,
  failedTaskCount: 0,
  cancelledTaskCount: 0,
  timedOutTaskCount: 0,
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
})

function renderPanel(overrides: Partial<Parameters<typeof BridgeHealthPanel>[0]> = {}) {
  const props: Parameters<typeof BridgeHealthPanel>[0] = {
    health: HEALTH,
    healthStatus: 'ready',
    canRetryHealth: true,
    onRetryHealth: vi.fn(),
    supportReportInput: REPORT_INPUT,
    toolPackStatus: {
      statusVersion: 1,
      coreApiVersion: 1,
      packs: [],
      truncatedCount: 0,
    },
    toolPackStatusLoadStatus: 'ready',
    toolPackStatusDiagnosticCode: null,
    canRetryToolPackStatus: false,
    onRetryToolPackStatus: vi.fn(),
    ...overrides,
  }
  return { ...render(<BridgeHealthPanel {...props} />), props }
}

function openAndGenerateReport() {
  fireEvent.click(screen.getByRole('button', { name: 'Bridge healthy' }))
  const generate = document.querySelector('[data-support-report-generate]')
  expect(generate).toBeInstanceOf(HTMLButtonElement)
  fireEvent.click(generate as HTMLButtonElement)
  return screen.getByLabelText('Support report') as HTMLTextAreaElement
}

describe('BridgeHealthPanel', () => {
  it('uses the canonical support summary for fixed overall statuses', () => {
    const cases: Array<{
      healthStatus: Parameters<typeof BridgeHealthPanel>[0]['healthStatus']
      health: WebUIHealth | null
      expected: string
      supportReportInput: SupportReportInput
    }> = [
      {
        healthStatus: 'unavailable',
        health: null,
        expected: 'unavailable',
        supportReportInput: {
          ...REPORT_INPUT,
          bridgeLifecycle: 'unavailable',
          bridgeDiagnosticCode: 'health_bridge_unavailable',
        },
      },
      {
        healthStatus: 'unsupported',
        health: null,
        expected: 'unsupported',
        supportReportInput: {
          ...REPORT_INPUT,
          bridgeLifecycle: 'unsupported',
          bridgeDiagnosticCode: 'health_method_unavailable',
        },
      },
      {
        healthStatus: 'loading',
        health: null,
        expected: 'checking',
        supportReportInput: { ...REPORT_INPUT, bridgeLifecycle: 'loading' },
      },
      {
        healthStatus: 'error',
        health: null,
        expected: 'error',
        supportReportInput: {
          ...REPORT_INPUT,
          bridgeLifecycle: 'error',
          bridgeDiagnosticCode: 'health_request_failed',
        },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'healthy',
        supportReportInput: REPORT_INPUT,
      },
      {
        healthStatus: 'ready',
        health: { ...HEALTH, pythonRuntime: 'unavailable' },
        expected: 'degraded',
        supportReportInput: { ...REPORT_INPUT, pythonRuntime: 'unavailable' },
      },
      {
        healthStatus: 'ready',
        health: { ...HEALTH, documentScope: 'inactive' },
        expected: 'unhealthy',
        supportReportInput: { ...REPORT_INPUT, documentScope: 'inactive' },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'checking',
        supportReportInput: { ...REPORT_INPUT, registryStatus: 'loading' },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'degraded',
        supportReportInput: { ...REPORT_INPUT, projectPersistenceStatus: 'disabled' },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'degraded',
        supportReportInput: { ...REPORT_INPUT, registryLoadErrorCount: 1 },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'degraded',
        supportReportInput: {
          ...REPORT_INPUT,
          catalogStatus: 'fallback',
          catalogSource: 'starter',
          catalogDiagnosticCode: 'catalog_missing',
        },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'checking',
        supportReportInput: {
          ...REPORT_INPUT,
          toolPackStatus: 'loading',
          toolPackStatusVersion: null,
          toolPackCoreApiVersion: null,
        },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'degraded',
        supportReportInput: {
          ...REPORT_INPUT,
          toolPackStatus: 'malformed',
          toolPackDiagnosticCode: 'tool_pack_response_invalid',
          toolPackStatusVersion: null,
          toolPackCoreApiVersion: null,
        },
      },
      {
        healthStatus: 'ready',
        health: HEALTH,
        expected: 'degraded',
        supportReportInput: {
          ...REPORT_INPUT,
          toolPackRejectedCount: 1,
          toolPackReasonCodes: ['tool_pack_load_rejected'],
        },
      },
    ]

    for (const healthCase of cases) {
      const { container, unmount } = renderPanel({
        healthStatus: healthCase.healthStatus,
        health: healthCase.health,
        supportReportInput: healthCase.supportReportInput,
      })
      expect(supportHealthSummary(healthCase.supportReportInput).overallStatus).toBe(healthCase.expected)
      expect(container.querySelector('[data-health-overall-status]')).toHaveAttribute(
        'data-health-overall-status',
        healthCase.expected,
      )
      unmount()
    }
  })

  it('exposes the required DOM contracts and generates a bounded v2 report preview', () => {
    const { container } = renderPanel()
    expect(container.querySelector('[data-health-panel-toggle]')).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('[data-health-overall-status]')).toHaveAttribute(
      'data-health-overall-status',
      'healthy',
    )

    const preview = openAndGenerateReport()
    expect(preview).toHaveAttribute('data-support-report-preview')
    expect(JSON.parse(preview.value)).toMatchObject({
      reportVersion: 2,
      product: 'unreal-editor-webui',
      health: { overallStatus: 'healthy', reasonCodes: [] },
      bridge: { lifecycle: 'ready' },
      toolPacks: {
        status: 'ready',
        diagnosticCode: null,
        statusVersion: 1,
        coreApiVersion: 1,
        loadedCount: 0,
        rejectedCount: 0,
        truncatedCount: 0,
        reasonCodes: [],
      },
    })
    expect(screen.getByText(/without paths, URLs, logs, or payloads/i)).toBeInTheDocument()
  })

  it('uses summary reason codes despite mismatched display props and keeps retry available', () => {
    const onRetryHealth = vi.fn()
    renderPanel({
      health: HEALTH,
      healthStatus: 'ready',
      onRetryHealth,
      supportReportInput: {
        ...REPORT_INPUT,
        bridgeLifecycle: 'error',
        bridgeDiagnosticCode: 'health_transport_invalid',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Health check failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('does not satisfy protocol v1')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onRetryHealth).toHaveBeenCalledOnce()
  })

  it('renders fixed Tool Pack health reason text without raw deployment diagnostics', () => {
    const secret = 'C:/Users/private/tool-pack.py?token=secret'
    renderPanel({
      supportReportInput: {
        ...REPORT_INPUT,
        toolPackRejectedCount: 1,
        toolPackReasonCodes: ['tool_pack_load_rejected'],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Bridge degraded' }))
    expect(screen.getByText('One or more Tool Packs were rejected.')).toHaveAttribute('role', 'status')
    expect(document.body.textContent).not.toContain(secret)
  })

  it('keeps aggregate project, catalog, and registry state visible without a native health method', () => {
    renderPanel({
      health: null,
      healthStatus: 'unsupported',
      canRetryHealth: false,
      supportReportInput: {
        ...REPORT_INPUT,
        bridgeLifecycle: 'unsupported',
        bridgeDiagnosticCode: 'health_method_unavailable',
        projectPersistenceStatus: 'disabled',
        registryStatus: 'error',
        catalogStatus: 'fallback',
        catalogSource: 'starter',
        catalogDiagnosticCode: 'catalog_bridge_unavailable',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Health diagnostics unavailable' }))
    expect(screen.getByText('Native health context').nextElementSibling).toHaveTextContent('unsupported')
    expect(screen.getByText('Project persistence').nextElementSibling).toHaveTextContent('disabled')
    expect(screen.getByText('Tool catalog').nextElementSibling).toHaveTextContent('starter · fallback')
    expect(screen.getByText('Command registry').nextElementSibling).toHaveTextContent('error')
  })

  it('copies exactly the generated report through the Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderPanel()
    const preview = openAndGenerateReport()

    fireEvent.click(screen.getByRole('button', { name: 'Copy support report' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(preview.value))
    expect(screen.getByText('Support report copied.')).toBeInTheDocument()
  })

  it('selects the safe preview for manual copy when Clipboard API access is unavailable', async () => {
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select')
    renderPanel()
    const preview = openAndGenerateReport()

    fireEvent.click(screen.getByRole('button', { name: 'Copy support report' }))
    await waitFor(() => expect(select).toHaveBeenCalledOnce())
    expect(preview).toHaveFocus()
    expect(screen.getByText(/selected for manual copy/)).toBeInTheDocument()
  })

  it('uses the same manual-copy fallback when Clipboard API rejects the write', async () => {
    const secret = 'clipboard-secret-that-must-not-be-rendered'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error(secret)) },
    })
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select')
    renderPanel()
    openAndGenerateReport()

    fireEvent.click(screen.getByRole('button', { name: 'Copy support report' }))
    await waitFor(() => expect(select).toHaveBeenCalledOnce())
    expect(document.body.textContent).not.toContain(secret)
    expect(screen.getByText(/selected for manual copy/)).toBeInTheDocument()
  })
})
