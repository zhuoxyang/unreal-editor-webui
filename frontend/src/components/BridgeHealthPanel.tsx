import { useMemo, useRef, useState } from 'react'
import type { WebUIHealthStatus } from '../hooks/useWebUIHealth'
import { webUIHealthDiagnosticMessage } from '../hooks/useWebUIHealth'
import {
  stringifySupportReport,
  supportHealthSummary,
  type SupportHealthOverallStatus,
  type SupportHealthReasonCode,
  type SupportReportInput,
} from '../support-report'
import type { WebUIDocumentScope, WebUIHealth } from '../types/bridge'

type BridgeHealthPanelProps = {
  health: WebUIHealth | null
  healthStatus: WebUIHealthStatus
  canRetryHealth: boolean
  onRetryHealth: () => void
  supportReportInput: SupportReportInput
}

const OVERALL_LABELS: Record<SupportHealthOverallStatus, string> = {
  unavailable: 'Bridge unavailable',
  unsupported: 'Health diagnostics unavailable',
  checking: 'Checking bridge health',
  healthy: 'Bridge healthy',
  degraded: 'Bridge degraded',
  unhealthy: 'Bridge inactive',
  error: 'Health check failed',
}

const DOCUMENT_SCOPE_LABELS: Record<WebUIDocumentScope, string> = {
  packaged: 'Packaged UI document',
  loopback_http: 'Loopback HTTP document',
  loopback_https: 'Loopback HTTPS document',
  inactive: 'Inactive document session',
}

function buildReportText(input: SupportReportInput) {
  try {
    return stringifySupportReport(input)
  } catch {
    return null
  }
}

function supportHealthReasonMessage(code: SupportHealthReasonCode): string {
  switch (code) {
    case 'health_bridge_unavailable':
    case 'health_method_unavailable':
    case 'health_transport_invalid':
    case 'health_request_failed':
      return webUIHealthDiagnosticMessage(code)
    case 'health_bridge_checking':
      return 'Bridge and startup health checks are still in progress.'
    case 'health_native_context_invalid':
      return 'The bridge reported an incomplete protocol v1 health context.'
    case 'health_document_inactive':
      return 'This document is not in an active bridge session.'
    case 'health_python_unavailable':
      return 'The Unreal Python runtime is unavailable.'
    case 'health_project_persistence_loading':
      return 'Project-scoped persistence is still being checked.'
    case 'health_project_persistence_unavailable':
      return 'Project-scoped persistence is unavailable.'
    case 'health_registry_loading':
      return 'Command discovery is still in progress.'
    case 'health_registry_unavailable':
      return 'Command discovery is unavailable. Check again after the bridge recovers.'
    case 'health_registry_modules_rejected':
      return 'One or more command modules did not load.'
    case 'health_catalog_loading':
      return 'The tool catalog is still being checked.'
    case 'health_catalog_fallback':
      return 'The starter catalog is active because the project catalog is unavailable.'
  }
}

export function BridgeHealthPanel({
  health,
  healthStatus,
  canRetryHealth,
  onRetryHealth,
  supportReportInput,
}: BridgeHealthPanelProps) {
  const [open, setOpen] = useState(false)
  const [reportText, setReportText] = useState<string | null>(null)
  const [reportMessage, setReportMessage] = useState('')
  const reportRef = useRef<HTMLTextAreaElement>(null)
  const currentReportText = useMemo(() => buildReportText(supportReportInput), [supportReportInput])
  const healthSummary = useMemo(() => supportHealthSummary(supportReportInput), [supportReportInput])
  const statusLabel = OVERALL_LABELS[healthSummary.overallStatus]
  const reasonMessages = healthSummary.reasonCodes.map(supportHealthReasonMessage)

  function generateReport() {
    setReportMessage('')
    if (!currentReportText) {
      setReportText(null)
      setReportMessage('The support report could not be generated.')
      return
    }
    setReportText(currentReportText)
    setReportMessage('Support report generated from the current health snapshot.')
  }

  async function copyReport() {
    if (!reportText) return
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable')
      }
      await navigator.clipboard.writeText(reportText)
      setReportMessage('Support report copied.')
    } catch {
      reportRef.current?.focus()
      reportRef.current?.select()
      setReportMessage('Clipboard access is unavailable. The support report is selected for manual copy.')
    }
  }

  return (
    <div className="bridge-health" data-health-overall-status={healthSummary.overallStatus}>
      <button
        aria-expanded={open}
        data-health-panel-toggle
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        {statusLabel}
      </button>

      {open ? (
        <section aria-label="Bridge and startup health" className="bridge-health-panel">
          <h2>Bridge and Startup Health</h2>
          <p
            role={healthSummary.overallStatus === 'error' || healthSummary.overallStatus === 'unhealthy'
              ? 'alert'
              : 'status'}
          >
            {reasonMessages[0] || statusLabel}
          </p>
          {reasonMessages.length > 1 ? (
            <ul aria-label="Additional health details">
              {reasonMessages.slice(1).map((message, index) => (
                <li key={`${healthSummary.reasonCodes[index + 1]}-${index}`}>{message}</li>
              ))}
            </ul>
          ) : null}

          <dl>
            {health ? (
              <>
                <div><dt>Plugin</dt><dd>{health.pluginVersion}</dd></div>
                <div><dt>Engine</dt><dd>{health.engineVersion}</dd></div>
                <div><dt>Document scope</dt><dd>{DOCUMENT_SCOPE_LABELS[health.documentScope]}</dd></div>
                <div>
                  <dt>Python runtime</dt>
                  <dd>{health.pythonRuntime === 'available' ? 'Available' : 'Unavailable'}</dd>
                </div>
                <div><dt>Privileged confirmation</dt><dd>Required per call</dd></div>
                <div><dt>Task isolation</dt><dd>Current document session</dd></div>
              </>
            ) : (
              <div><dt>Native health context</dt><dd>{healthStatus}</dd></div>
            )}
            <div>
              <dt>Project persistence</dt>
              <dd>{supportReportInput.projectPersistenceStatus}</dd>
            </div>
            <div>
              <dt>Tool catalog</dt>
              <dd>
                {supportReportInput.catalogSource} · {supportReportInput.catalogStatus} · schema v
                {supportReportInput.catalogSchemaVersion}
              </dd>
            </div>
            <div>
              <dt>Command registry</dt>
              <dd>
                {supportReportInput.registryStatus} · {supportReportInput.registryAvailableCount} available ·{' '}
                {supportReportInput.registryLoadErrorCount} rejected
              </dd>
            </div>
          </dl>

          {canRetryHealth ? (
            <button type="button" disabled={healthStatus === 'loading'} onClick={onRetryHealth}>
              {healthStatus === 'loading' ? 'Checking…' : 'Check again'}
            </button>
          ) : null}

          <div className="support-report">
            <h3>Support Report</h3>
            <p>The report contains bounded status codes and counts, without paths, URLs, logs, or payloads.</p>
            <button data-support-report-generate type="button" onClick={generateReport}>
              Generate support report
            </button>
            {reportText ? (
              <>
                <textarea
                  aria-label="Support report"
                  data-support-report-preview
                  readOnly
                  ref={reportRef}
                  rows={14}
                  value={reportText}
                />
                <button type="button" onClick={() => void copyReport()}>Copy support report</button>
              </>
            ) : null}
            {reportMessage ? <p role="status">{reportMessage}</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
