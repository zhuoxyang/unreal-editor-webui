import {
  toolPackRejectionReasonCode,
  toolPackStatusDiagnosticMessage,
  type ToolPackStatusDiagnosticCode,
  type ToolPackStatusLoadStatus,
} from '../hooks/useToolPackStatus'
import type { ToolPackBackendReasonCode, ToolPackStatus } from '../types/bridge'

type ToolPackStatusPanelProps = {
  status: ToolPackStatus | null
  loadStatus: ToolPackStatusLoadStatus
  diagnosticCode: ToolPackStatusDiagnosticCode | null
  canRetry: boolean
  onRetry: () => void
}

function v2ReasonMessage(reasonCode: ToolPackBackendReasonCode) {
  switch (reasonCode) {
    case 'trust_policy_invalid':
      return 'Rejected because the project Tool Pack policy is invalid.'
    case 'trust_anchor_missing':
      return 'Rejected because this Tool Pack is not approved by the project policy.'
    case 'trusted_payload_mismatch':
      return 'Rejected because the installed payload does not match the approved hash.'
    case 'trusted_payload_unverifiable':
      return 'Rejected because the installed payload could not be verified safely.'
    case 'trusted_plugin_version_mismatch':
      return 'Rejected because the installed plugin version is not approved.'
    case 'trusted_core_api_mismatch':
      return 'Rejected because the approved core API does not match this Tool Pack.'
    case 'trusted_pack_missing':
      return 'The project policy requires a Tool Pack that is not installed.'
    case 'dependency_hash_mismatch':
    case 'unlocked_vendored_dependencies':
    case 'vendored_dependencies_missing':
      return 'Rejected because its vendored Python dependency lock is invalid.'
    case 'dependency_policy_invalid':
    case 'in_process_native_dependency_unsupported':
      return 'Rejected because its dependency policy is unsupported.'
    case 'startup_hook_forbidden':
      return 'Rejected because Tool Packs may not provide an Unreal Python startup hook.'
    case 'undeclared_registration_origin':
      return 'Rejected because a command was registered outside a declared entry module.'
    case 'entry_module_ambiguous':
    case 'entry_module_duplicate':
    case 'entry_module_invalid':
    case 'entry_module_missing':
    case 'entry_modules_invalid':
      return 'Rejected because its declared entry modules are invalid.'
    case 'command_namespace_conflict':
    case 'pack_id_conflict':
    case 'plugin_name_conflict':
    case 'python_package_conflict':
    case 'tool_pack_conflict':
      return 'Rejected because its identity or command namespace conflicts with another Tool Pack.'
    case 'command_registration_rejected':
    case 'entry_import_failed':
    case 'validation_failed':
      return 'Rejected while the Tool Pack was validated or loaded.'
  }
}

function rejectionMessage(
  pack: Extract<ToolPackStatus['packs'][number], { state: 'rejected' }>,
  coreApiVersion: number,
) {
  if ('reasonCodes' in pack && pack.reasonCodes.length > 0) {
    return v2ReasonMessage(pack.reasonCodes[0])
  }
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
          {status.statusVersion === 2 && status.policy.state === 'rejected' ? (
            <p className="inline-warning" role="alert">
              {status.policy.reasonCodes[0]
                ? v2ReasonMessage(status.policy.reasonCodes[0])
                : 'The project Tool Pack policy was rejected.'}
            </p>
          ) : null}
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
