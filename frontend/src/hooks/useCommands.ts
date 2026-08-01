import { useCallback, useEffect, useRef, useState } from 'react'
import { createRequestId, formatBridgeError } from '../bridge'
import type { BridgeCaller } from '../bridge'
import { decodeCommandsResult } from '../bridge-decoders'
import type { CommandMetadata } from '../types/command'

export type CommandsLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

type UseCommandsOptions = {
  bridgeReady: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

export function useCommands({ bridgeReady, callBridgeQuiet, log }: UseCommandsOptions) {
  const [commands, setCommands] = useState<CommandMetadata[]>([])
  const [status, setStatus] = useState<CommandsLoadStatus>('idle')
  const [error, setError] = useState('')
  const requestSequenceRef = useRef(0)
  const loadingRef = useRef(false)

  const loadCommands = useCallback(async () => {
    if (!bridgeReady || loadingRef.current) {
      return
    }

    loadingRef.current = true
    requestSequenceRef.current += 1
    const requestSequence = requestSequenceRef.current
    setStatus('loading')
    setError('')
    try {
      const result = await callBridgeQuiet<unknown>(
        'executecommand',
        JSON.stringify({
          id: createRequestId(),
          command: 'system.commands',
          payload: {},
        }),
      )
      const decoded = decodeCommandsResult(result)
      if (requestSequenceRef.current === requestSequence) {
        setCommands(decoded.commands)
        setStatus('ready')
      }
    } catch (caught) {
      if (requestSequenceRef.current === requestSequence) {
        const message = formatBridgeError(caught)
        setError(message)
        setStatus('error')
        log(message)
      }
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        loadingRef.current = false
      }
    }
  }, [bridgeReady, callBridgeQuiet, log])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void loadCommands()
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [bridgeReady, loadCommands])

  return {
    commands,
    commandsError: error,
    commandsStatus: bridgeReady ? status : 'idle',
    retryCommands: loadCommands,
    setCommands,
  }
}
