import { useCallback } from 'react'
import type { BridgeResponse } from './types/bridge'

export type { BridgeResponse, TaskResult, TaskStatus, WebUISettings } from './types/bridge'

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
export type BridgeMethodName = keyof EditorWebUIBridge
export type BridgeCaller = <T>(methodName: BridgeMethodName, ...args: string[]) => Promise<T>

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
