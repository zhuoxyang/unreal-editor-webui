import {
  toolPackRejectionReasonCode,
  toolPackStatusDiagnosticMessage,
  type ToolPackStatusDiagnosticCode,
  type ToolPackStatusLoadStatus,
} from '../hooks/useToolPackStatus'
import type { ToolPackStatusV1 } from '../types/bridge'

type ToolPackStatusPanelProps = {
  status: ToolPackStatusV1 | null
  loadStatus: ToolPackStatusLoadStatus
  diagnosticCode: ToolPackStatusDiagnosticCode | null
  canRetry: boolean
  onRetry: () => void
}

function rejectionMessage(
  pack: Extract<ToolPackStatusV1['packs'][number], { state: 'rejected' }>,
  coreApiVersion: number,
) {
  switch (toolPackRejectionReasonCode(pack, coreApiVersion)) {
    case 'tool_pack_core_api_mismatch':
      return 'Rejected because the Tool Pack requires a different core API version.'
    case 'tool_pack_discovery_rejected':
      return 'Rejected during Tool Pack descriptor discovery.'
    case 'tool_pack_load_rejected':
      return 'Rejected while the Tool Pack was loaded.'
  }
}

export function ToolPackStatusPanel({
  status,
  loadStatus,
  diagnosticCode,
  canRetry,
  onRetry,
}: ToolPackStatusPanelProps) {
  const loadedCount = status?.packs.filter((pack) => pack.state === 'loaded').length ?? 0
  const rejectedCount = status?.packs.filter((pack) => pack.state === 'rejected').length ?? 0

  return (
    <section
      aria-label="Tool Pack deployment status"
      className="tool-pack-status"
      data-tool-pack-status={loadStatus}
    >
      <h3>Tool Packs</h3>

      {loadStatus === 'loading' ? <p role="status">Checking Tool Pack deployment status…</p> : null}

      {loadStatus === 'ready' && status ? (
        <>
          <p role="status">
            {loadedCount} loaded · {rejectedCount} rejected · core API v{status.coreApiVersion}
          </p>
          {status.packs.length === 0 ? <p>No third-party Tool Packs discovered.</p> : (
            <ul className="tool-pack-status-list">
              {status.packs.map((pack, index) => (
                <li key={`${pack.packId ?? pack.pluginName}-${index}`}>
                  <div className="tool-pack-status-title">
                    <strong>{pack.packId ?? pack.pluginName}</strong>
                    <span className={`badge ${pack.state}`}>{pack.state}</span>
                  </div>
                  {pack.packId ? (
                    <p>
                      Plugin {pack.pluginName} {pack.pluginVersion} · Required API v{pack.requiredCoreApi} · Core API v
                      {status.coreApiVersion}
                    </p>
                  ) : (
                    <p>Plugin {pack.pluginName} · descriptor unavailable</p>
                  )}
                  {pack.state === 'loaded' ? (
                    <p>{pack.commandCount} commands: {pack.commands.join(', ')}</p>
                  ) : (
                    <p>{rejectionMessage(pack, status.coreApiVersion)}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status.truncatedCount > 0 ? (
            <p className="inline-warning" role="status">
              {status.truncatedCount} cumulative Tool Pack status observations were omitted by the bounded registry history.
            </p>
          ) : null}
        </>
      ) : null}

      {loadStatus !== 'loading' && loadStatus !== 'ready' ? (
        <p role={loadStatus === 'error' || loadStatus === 'malformed' ? 'alert' : 'status'}>
          {diagnosticCode
            ? toolPackStatusDiagnosticMessage(diagnosticCode)
            : 'Tool Pack deployment status is unavailable.'}
        </p>
      ) : null}

      {canRetry ? <button type="button" onClick={onRetry}>Check Tool Packs again</button> : null}

      <p className="muted">
        Tool Pack deployment changes are discovered during registry initialization. Restart Unreal Editor after installing,
        enabling, updating, disabling, or removing a Tool Pack.
      </p>
    </section>
  )
}
