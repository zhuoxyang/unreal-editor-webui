import { useCallback, useEffect, useState } from 'react'
import { BridgeProtocolError, type BridgeCaller } from '../bridge'
import { decodeWebUIHealth } from '../bridge-decoders'
import type { WebUIHealth } from '../types/bridge'

export type WebUIHealthStatus = 'unavailable' | 'unsupported' | 'loading' | 'ready' | 'error'

export type WebUIHealthDiagnosticCode =
  | 'health_bridge_unavailable'
  | 'health_method_unavailable'
  | 'health_transport_invalid'
  | 'health_request_failed'

type WebUIHealthFailureDiagnosticCode = Extract<
  WebUIHealthDiagnosticCode,
  'health_transport_invalid' | 'health_request_failed'
>

type UseWebUIHealthOptions = {
  bridgeReady: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

type HealthResolution = {
  attempt: number
  caller: BridgeCaller
  health: WebUIHealth | null
  diagnosticCode: WebUIHealthFailureDiagnosticCode | null
}

export function webUIHealthDiagnosticMessage(code: WebUIHealthDiagnosticCode) {
  if (code === 'health_bridge_unavailable') {
    return 'The Unreal Editor WebUI bridge is unavailable.'
  }
  if (code === 'health_method_unavailable') {
    return 'This plugin version does not expose Web UI health diagnostics.'
  }
  if (code === 'health_transport_invalid') {
    return 'The Web UI health response does not satisfy protocol v1.'
  }
  return 'The Web UI health check failed. Try again.'
}

function fixedDiagnosticCode(error: unknown): WebUIHealthFailureDiagnosticCode {
  return error instanceof BridgeProtocolError
    ? 'health_transport_invalid'
    : 'health_request_failed'
}

export function useWebUIHealth({ bridgeReady, callBridgeQuiet, log }: UseWebUIHealthOptions) {
  const [attempt, setAttempt] = useState(0)
  const [resolution, setResolution] = useState<HealthResolution | null>(null)
  const bridgeHasHealth = bridgeReady && typeof window.ue?.editorwebui?.getwebuihealth === 'function'

  useEffect(() => {
    let stopped = false
    if (!bridgeHasHealth) {
      return () => {
        stopped = true
      }
    }

    void callBridgeQuiet<unknown>('getwebuihealth')
      .then((result) => {
        if (stopped) return
        setResolution({
          attempt,
          caller: callBridgeQuiet,
          health: decodeWebUIHealth(result),
          diagnosticCode: null,
        })
      })
      .catch((error: unknown) => {
        if (stopped) return
        const diagnosticCode = fixedDiagnosticCode(error)
        log(webUIHealthDiagnosticMessage(diagnosticCode))
        setResolution({
          attempt,
          caller: callBridgeQuiet,
          health: null,
          diagnosticCode,
        })
      })

    return () => {
      stopped = true
    }
  }, [attempt, bridgeHasHealth, callBridgeQuiet, log])

  const retryHealth = useCallback(() => {
    if (bridgeHasHealth) {
      setAttempt((value) => value + 1)
    }
  }, [bridgeHasHealth])

  if (!bridgeReady) {
    const diagnosticCode = 'health_bridge_unavailable' as const
    return {
      health: null,
      healthStatus: 'unavailable' as const,
      healthDiagnosticCode: diagnosticCode,
      healthDiagnostic: webUIHealthDiagnosticMessage(diagnosticCode),
      canRetryHealth: false,
      retryHealth,
    }
  }

  if (!bridgeHasHealth) {
    const diagnosticCode = 'health_method_unavailable' as const
    return {
      health: null,
      healthStatus: 'unsupported' as const,
      healthDiagnosticCode: diagnosticCode,
      healthDiagnostic: webUIHealthDiagnosticMessage(diagnosticCode),
      canRetryHealth: false,
      retryHealth,
    }
  }

  const currentResolution = resolution?.caller === callBridgeQuiet && resolution.attempt === attempt
    ? resolution
    : null
  if (!currentResolution) {
    return {
      health: null,
      healthStatus: 'loading' as const,
      healthDiagnosticCode: null,
      healthDiagnostic: '',
      canRetryHealth: true,
      retryHealth,
    }
  }

  if (currentResolution.health) {
    return {
      health: currentResolution.health,
      healthStatus: 'ready' as const,
      healthDiagnosticCode: null,
      healthDiagnostic: '',
      canRetryHealth: true,
      retryHealth,
    }
  }

  const diagnosticCode = currentResolution.diagnosticCode || 'health_request_failed'
  return {
    health: null,
    healthStatus: 'error' as const,
    healthDiagnosticCode: diagnosticCode,
    healthDiagnostic: webUIHealthDiagnosticMessage(diagnosticCode),
    canRetryHealth: true,
    retryHealth,
  }
}
