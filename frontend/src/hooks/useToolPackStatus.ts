import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BridgeCallError,
  BridgeProtocolError,
  createRequestId,
  type BridgeCaller,
} from '../bridge'
import {
  decodeToolPackStatus,
  UnsupportedToolPackStatusVersionError,
} from '../bridge-decoders'
import type { CommandsLoadStatus } from './useCommands'
import type { ToolPackRejectedStatusV1, ToolPackStatusV1 } from '../types/bridge'

export type ToolPackStatusLoadStatus =
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'malformed'
  | 'error'

export type ToolPackStatusDiagnosticCode =
  | 'tool_pack_bridge_unavailable'
  | 'tool_pack_registry_unavailable'
  | 'tool_pack_command_unavailable'
  | 'tool_pack_schema_unsupported'
  | 'tool_pack_response_invalid'
  | 'tool_pack_request_failed'

export type ToolPackRejectionReasonCode =
  | 'tool_pack_core_api_mismatch'
  | 'tool_pack_discovery_rejected'
  | 'tool_pack_load_rejected'

export type ToolPackStatusReasonCode =
  | ToolPackRejectionReasonCode
  | 'tool_pack_status_truncated'

type UseToolPackStatusOptions = {
  bridgeReady: boolean
  commandsStatus: CommandsLoadStatus
  commandAvailable: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

type ToolPackResolution = {
  attempt: number
  generation: object
  caller: BridgeCaller
  status: ToolPackStatusV1 | null
  loadStatus: Extract<ToolPackStatusLoadStatus, 'ready' | 'unsupported' | 'malformed' | 'error'>
  diagnosticCode: ToolPackStatusDiagnosticCode | null
}

export function toolPackStatusDiagnosticMessage(code: ToolPackStatusDiagnosticCode): string {
  switch (code) {
    case 'tool_pack_bridge_unavailable':
      return 'The Unreal Editor WebUI bridge is unavailable.'
    case 'tool_pack_registry_unavailable':
      return 'Command discovery must recover before Tool Pack status can be checked.'
    case 'tool_pack_command_unavailable':
      return 'This core plugin version does not expose Tool Pack deployment status.'
    case 'tool_pack_schema_unsupported':
      return 'This Web UI does not support the Tool Pack status schema returned by the core plugin.'
    case 'tool_pack_response_invalid':
      return 'The Tool Pack status response does not satisfy schema v1.'
    case 'tool_pack_request_failed':
      return 'The Tool Pack status check failed. Try again.'
  }
}

export function toolPackRejectionReasonCode(
  pack: ToolPackRejectedStatusV1,
  coreApiVersion: number,
): ToolPackRejectionReasonCode {
  if (pack.requiredCoreApi !== null && pack.requiredCoreApi !== coreApiVersion) {
    return 'tool_pack_core_api_mismatch'
  }
  if (pack.packId === null) {
    return 'tool_pack_discovery_rejected'
  }
  return 'tool_pack_load_rejected'
}

export function toolPackStatusReasonCodes(status: ToolPackStatusV1): ToolPackStatusReasonCode[] {
  const present = new Set<ToolPackStatusReasonCode>()
  for (const pack of status.packs) {
    if (pack.state === 'rejected') {
      present.add(toolPackRejectionReasonCode(pack, status.coreApiVersion))
    }
  }
  if (status.truncatedCount > 0) present.add('tool_pack_status_truncated')
  const order: ToolPackStatusReasonCode[] = [
    'tool_pack_core_api_mismatch',
    'tool_pack_discovery_rejected',
    'tool_pack_load_rejected',
    'tool_pack_status_truncated',
  ]
  return order.filter((code) => present.has(code))
}

function failureResolution(
  error: unknown,
): Pick<ToolPackResolution, 'loadStatus' | 'diagnosticCode'> {
  if (error instanceof UnsupportedToolPackStatusVersionError) {
    return { loadStatus: 'unsupported', diagnosticCode: 'tool_pack_schema_unsupported' }
  }
  if (error instanceof BridgeCallError && error.code === 'unknown_command') {
    return { loadStatus: 'unsupported', diagnosticCode: 'tool_pack_command_unavailable' }
  }
  if (error instanceof BridgeProtocolError) {
    return { loadStatus: 'malformed', diagnosticCode: 'tool_pack_response_invalid' }
  }
  return { loadStatus: 'error', diagnosticCode: 'tool_pack_request_failed' }
}

export function useToolPackStatus({
  bridgeReady,
  commandsStatus,
  commandAvailable,
  callBridgeQuiet,
  log,
}: UseToolPackStatusOptions) {
  const [attempt, setAttempt] = useState(0)
  const [resolution, setResolution] = useState<ToolPackResolution | null>(null)
  const canRequest = bridgeReady && commandsStatus === 'ready' && commandAvailable
  const generation = useMemo(
    () => ({ bridgeReady, commandAvailable, commandsStatus }),
    [bridgeReady, commandAvailable, commandsStatus],
  )

  useEffect(() => {
    let stopped = false
    if (!canRequest) {
      return () => {
        stopped = true
      }
    }

    void callBridgeQuiet<unknown>(
      'executecommand',
      JSON.stringify({
        id: createRequestId(),
        command: 'system.toolPacks',
        payload: {},
      }),
    )
      .then((value) => {
        if (stopped) return
        setResolution({
          attempt,
          generation,
          caller: callBridgeQuiet,
          status: decodeToolPackStatus(value),
          loadStatus: 'ready',
          diagnosticCode: null,
        })
      })
      .catch((error: unknown) => {
        if (stopped) return
        const failure = failureResolution(error)
        if (failure.diagnosticCode) log(toolPackStatusDiagnosticMessage(failure.diagnosticCode))
        setResolution({
          attempt,
          generation,
          caller: callBridgeQuiet,
          status: null,
          ...failure,
        })
      })

    return () => {
      stopped = true
    }
  }, [attempt, callBridgeQuiet, canRequest, generation, log])

  const retryToolPackStatus = useCallback(() => {
    if (canRequest) setAttempt((value) => value + 1)
  }, [canRequest])

  if (!bridgeReady) {
    const diagnosticCode = 'tool_pack_bridge_unavailable' as const
    return {
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'unavailable' as const,
      toolPackStatusDiagnosticCode: diagnosticCode,
      toolPackStatusDiagnostic: toolPackStatusDiagnosticMessage(diagnosticCode),
      canRetryToolPackStatus: false,
      retryToolPackStatus,
    }
  }
  if (commandsStatus === 'idle' || commandsStatus === 'loading') {
    return {
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading' as const,
      toolPackStatusDiagnosticCode: null,
      toolPackStatusDiagnostic: '',
      canRetryToolPackStatus: false,
      retryToolPackStatus,
    }
  }
  if (commandsStatus === 'error') {
    const diagnosticCode = 'tool_pack_registry_unavailable' as const
    return {
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'error' as const,
      toolPackStatusDiagnosticCode: diagnosticCode,
      toolPackStatusDiagnostic: toolPackStatusDiagnosticMessage(diagnosticCode),
      canRetryToolPackStatus: false,
      retryToolPackStatus,
    }
  }
  if (!commandAvailable) {
    const diagnosticCode = 'tool_pack_command_unavailable' as const
    return {
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'unsupported' as const,
      toolPackStatusDiagnosticCode: diagnosticCode,
      toolPackStatusDiagnostic: toolPackStatusDiagnosticMessage(diagnosticCode),
      canRetryToolPackStatus: false,
      retryToolPackStatus,
    }
  }

  const currentResolution = resolution?.caller === callBridgeQuiet
    && resolution.attempt === attempt
    && resolution.generation === generation
    ? resolution
    : null
  if (!currentResolution) {
    return {
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading' as const,
      toolPackStatusDiagnosticCode: null,
      toolPackStatusDiagnostic: '',
      canRetryToolPackStatus: false,
      retryToolPackStatus,
    }
  }
  return {
    toolPackStatus: currentResolution.status,
    toolPackStatusLoadStatus: currentResolution.loadStatus,
    toolPackStatusDiagnosticCode: currentResolution.diagnosticCode,
    toolPackStatusDiagnostic: currentResolution.diagnosticCode
      ? toolPackStatusDiagnosticMessage(currentResolution.diagnosticCode)
      : '',
    canRetryToolPackStatus: currentResolution.loadStatus !== 'ready',
    retryToolPackStatus,
  }
}
