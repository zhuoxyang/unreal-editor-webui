import { useEffect, useState } from 'react'
import { formatBridgeError, type BridgeCaller } from '../bridge'
import { decodeProjectContext } from '../bridge-decoders'
import type { ProjectContext } from '../types/bridge'

type UseProjectContextOptions = {
  bridgeReady: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

export type ProjectStorageContext = {
  projectName: string
  storageNamespace: string | null
  persistenceEnabled: boolean
}

export type ProjectContextLoadStatus = 'loading' | 'ready' | 'unavailable'

const DISABLED_CONTEXT: ProjectStorageContext = {
  projectName: 'Unknown project',
  storageNamespace: null,
  persistenceEnabled: false,
}

export function useProjectContext({ bridgeReady, callBridgeQuiet, log }: UseProjectContextOptions) {
  const [resolution, setResolution] = useState<{
    caller: BridgeCaller
    context: ProjectContext | null
  } | null>(null)
  const bridgeHasProjectContext = bridgeReady && typeof window.ue?.editorwebui?.getprojectcontext === 'function'

  useEffect(() => {
    let stopped = false
    if (!bridgeHasProjectContext) {
      return () => {
        stopped = true
      }
    }

    void callBridgeQuiet<unknown>('getprojectcontext')
      .then((result) => {
        if (!stopped) {
          setResolution({ caller: callBridgeQuiet, context: decodeProjectContext(result) })
        }
      })
      .catch((error) => {
        if (!stopped) {
          const message = `Unable to resolve project storage context: ${formatBridgeError(error)}`
          log(message)
          setResolution({ caller: callBridgeQuiet, context: null })
        }
      })

    return () => {
      stopped = true
    }
  }, [bridgeHasProjectContext, callBridgeQuiet, log])

  const currentResolution = resolution?.caller === callBridgeQuiet ? resolution : null
  const projectContextStatus: ProjectContextLoadStatus = !bridgeHasProjectContext
    ? 'unavailable'
    : !currentResolution
      ? 'loading'
      : currentResolution.context
        ? 'ready'
        : 'unavailable'
  return {
    projectContext: bridgeHasProjectContext && currentResolution?.context
      ? { ...currentResolution.context, persistenceEnabled: true }
      : DISABLED_CONTEXT,
    projectContextReady: bridgeHasProjectContext ? currentResolution !== null : true,
    projectContextStatus,
  }
}
