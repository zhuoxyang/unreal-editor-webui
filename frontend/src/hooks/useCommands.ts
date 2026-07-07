import { useEffect, useState } from 'react'
import { createRequestId } from '../bridge'
import type { BridgeCaller } from '../bridge'
import type { CommandMetadata } from '../types/command'

type UseCommandsOptions = {
  bridgeReady: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

export function useCommands({ bridgeReady, callBridgeQuiet, log }: UseCommandsOptions) {
  const [commands, setCommands] = useState<CommandMetadata[]>([])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void callBridgeQuiet<{ commands: CommandMetadata[] }>(
        'executecommand',
        JSON.stringify({
          id: createRequestId(),
          command: 'system.commands',
          payload: {},
        }),
      )
        .then((result) => setCommands(Array.isArray(result.commands) ? result.commands : []))
        .catch((error) => log(error instanceof Error ? error.message : String(error)))
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [bridgeReady, callBridgeQuiet, log])

  return { commands, setCommands }
}

