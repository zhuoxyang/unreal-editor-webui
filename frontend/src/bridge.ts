import { useCallback } from 'react'

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

export type BridgeResponse<T> =
  | {
      id: string | null
      ok: true
      result: T
    }
  | {
      id: string | null
      ok: false
      error: {
        code: string
        message: string
        details?: string[]
        traceback?: string
      }
    }

export type TaskResult = {
  taskId: string
  status: TaskStatus
  command?: string
  payload?: Record<string, unknown>
  progress?: number
  cancellable?: boolean
  cancellationMode?: string
  executionThread?: string
  timeoutPolicy?: string
  message?: string
  logs?: string[]
  createdAt?: string
  updatedAt?: string
  responseJson?: string
}

export type WebUISettings = {
  useDevServer: boolean
  devServerUrl: string
  startupUrl: string
  resolvedUrl: string
}

declare global {
  interface Window {
    ue?: {
      editorwebui?: {
        executecommand(requestJson: string): Promise<string>
        startcommand(requestJson: string): Promise<string>
        gettask(taskId: string): Promise<string>
        listtasks(): Promise<string>
        removetask(taskId: string): Promise<string>
        canceltask(taskId: string): Promise<string>
        getwebuisettings(): Promise<string>
        setwebuisettings(settingsJson: string): Promise<string>
      }
    }
  }
}

type EditorWebUIBridge = NonNullable<NonNullable<Window['ue']>['editorwebui']>
type BridgeMethodName = keyof EditorWebUIBridge

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useEditorBridge(log?: (message: string) => void) {
  const bridge = window.ue?.editorwebui
  const bridgeReady = Boolean(bridge)

  const callBridge = useCallback(async <T,>(methodName: BridgeMethodName, ...args: string[]) => {
    if (!bridge || typeof bridge[methodName] !== 'function') {
      throw new Error(`Bridge method unavailable: ${methodName}`)
    }

    const method = bridge[methodName] as (...methodArgs: string[]) => Promise<string>
    const responseJson = await method(...args)
    const response = JSON.parse(responseJson) as BridgeResponse<T>
    log?.(`${methodName} -> ${JSON.stringify(response, null, 2)}`)

    if (!response.ok) {
      throw new Error(response.error.message)
    }

    return response.result
  }, [bridge, log])

  const callBridgeQuiet = useCallback(async <T,>(methodName: BridgeMethodName, ...args: string[]) => {
    if (!bridge || typeof bridge[methodName] !== 'function') {
      throw new Error(`Bridge method unavailable: ${methodName}`)
    }

    const method = bridge[methodName] as (...methodArgs: string[]) => Promise<string>
    const responseJson = await method(...args)
    const response = JSON.parse(responseJson) as BridgeResponse<T>

    if (!response.ok) {
      throw new Error(response.error.message)
    }

    return response.result
  }, [bridge])

  return {
    bridgeReady,
    callBridge,
    callBridgeQuiet,
  }
}
