import { useCallback } from 'react'
import type { BridgeResponse } from './types/bridge'

export type { BridgeResponse, ProjectContext, TaskResult, TaskStatus, WebUISettings } from './types/bridge'

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
        getprojectcontext?(): Promise<string>
      }
    }
  }
}

type EditorWebUIBridge = NonNullable<NonNullable<Window['ue']>['editorwebui']>
export type BridgeMethodName = keyof EditorWebUIBridge
export type BridgeCaller = <T>(methodName: BridgeMethodName, ...args: string[]) => Promise<T>

const MAX_RESPONSE_PREVIEW_LENGTH = 200
const MAX_ERROR_DETAIL_LENGTH = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responsePreview(responseJson: string) {
  const compact = responseJson.replace(/\s+/g, ' ').trim()
  return compact.length <= MAX_RESPONSE_PREVIEW_LENGTH
    ? compact
    : `${compact.slice(0, MAX_RESPONSE_PREVIEW_LENGTH)}…`
}

function resultSummary(result: unknown) {
  if (result === null) return 'null'
  if (Array.isArray(result)) return `array(${result.length})`
  if (isRecord(result)) {
    const keys = Object.keys(result)
    const visibleKeys = keys.slice(0, 6).join(',')
    return `object(${keys.length}${visibleKeys ? `: ${visibleKeys}${keys.length > 6 ? ',…' : ''}` : ''})`
  }
  if (typeof result === 'string') return `string(${result.length})`
  return typeof result
}

function boundedErrorDetail(value: string) {
  return value.length <= MAX_ERROR_DETAIL_LENGTH ? value : `${value.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
}

export class BridgeProtocolError extends Error {
  readonly methodName: BridgeMethodName
  readonly responsePreview?: string

  constructor(
    methodName: BridgeMethodName,
    message: string,
    preview?: string,
  ) {
    super(`Invalid bridge response from ${methodName}: ${message}`)
    this.name = 'BridgeProtocolError'
    this.methodName = methodName
    this.responsePreview = preview
  }
}

export class BridgeCallError extends Error {
  readonly methodName: BridgeMethodName
  readonly code: string
  readonly details?: string[]
  readonly requestId: string | null

  constructor(
    methodName: BridgeMethodName,
    code: string,
    message: string,
    details?: string[],
    requestId: string | null = null,
  ) {
    super(message)
    this.name = 'BridgeCallError'
    this.methodName = methodName
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

export function formatBridgeError(error: unknown) {
  if (error instanceof BridgeCallError) {
    const details = error.details?.slice(0, 3).map(boundedErrorDetail).join('; ')
    const request = error.requestId ? ` (request ${error.requestId})` : ''
    return `[${error.code}] ${error.message}${details ? ` — ${details}` : ''}${request}`
  }
  return error instanceof Error ? error.message : String(error)
}

export function parseBridgeResponse<T>(
  methodName: BridgeMethodName,
  rawResponse: unknown,
): BridgeResponse<T> {
  if (typeof rawResponse !== 'string') {
    throw new BridgeProtocolError(methodName, 'response must be a JSON string.')
  }

  const preview = responsePreview(rawResponse)
  let parsed: unknown
  try {
    parsed = JSON.parse(rawResponse)
  } catch {
    throw new BridgeProtocolError(
      methodName,
      `response is not valid JSON${preview ? `: ${preview}` : '.'}`,
      preview,
    )
  }

  if (!isRecord(parsed)) {
    throw new BridgeProtocolError(methodName, 'response must be a JSON object.', preview)
  }

  if (typeof parsed.ok !== 'boolean') {
    throw new BridgeProtocolError(methodName, 'field "ok" must be a boolean.', preview)
  }

  if (parsed.id !== null && typeof parsed.id !== 'string') {
    throw new BridgeProtocolError(methodName, 'field "id" must be a string or null.', preview)
  }

  if (parsed.ok) {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'result')) {
      throw new BridgeProtocolError(methodName, 'successful response is missing field "result".', preview)
    }
    return parsed as BridgeResponse<T>
  }

  if (!isRecord(parsed.error)) {
    throw new BridgeProtocolError(methodName, 'failed response is missing object field "error".', preview)
  }

  const { code, message, details, traceback } = parsed.error
  if (typeof code !== 'string' || !code || typeof message !== 'string' || !message) {
    throw new BridgeProtocolError(
      methodName,
      'failed response requires non-empty "error.code" and "error.message" strings.',
      preview,
    )
  }
  if (details !== undefined && (!Array.isArray(details) || details.some((item) => typeof item !== 'string'))) {
    throw new BridgeProtocolError(methodName, 'field "error.details" must be an array of strings.', preview)
  }
  if (traceback !== undefined && typeof traceback !== 'string') {
    throw new BridgeProtocolError(methodName, 'field "error.traceback" must be a string.', preview)
  }

  return parsed as BridgeResponse<T>
}

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useEditorBridge(log?: (message: string) => void) {
  const bridge = window.ue?.editorwebui
  const bridgeReady = Boolean(bridge)

  const invokeBridge = useCallback(async <T,>(
    methodName: BridgeMethodName,
    args: string[],
    shouldLog: boolean,
  ) => {
    if (!bridge || typeof bridge[methodName] !== 'function') {
      throw new Error(`Bridge method unavailable: ${methodName}`)
    }

    const method = bridge[methodName] as (...methodArgs: string[]) => Promise<unknown>
    const rawResponse = await method.apply(bridge, args)
    const response = parseBridgeResponse<T>(methodName, rawResponse)
    const responseLength = typeof rawResponse === 'string' ? rawResponse.length : 0
    if (shouldLog) {
      const id = response.id || '-'
      log?.(
        response.ok
          ? `${methodName} -> ok id=${id} result=${resultSummary(response.result)} chars=${responseLength}`
          : `${methodName} -> error id=${id} code=${response.error.code} chars=${responseLength}`,
      )
    }

    if (!response.ok) {
      throw new BridgeCallError(
        methodName,
        response.error.code,
        response.error.message,
        response.error.details,
        response.id,
      )
    }

    return response.result
  }, [bridge, log])

  const callBridge = useCallback(<T,>(methodName: BridgeMethodName, ...args: string[]) => {
    return invokeBridge<T>(methodName, args, true)
  }, [invokeBridge])

  const callBridgeQuiet = useCallback(async <T,>(methodName: BridgeMethodName, ...args: string[]) => {
    return invokeBridge<T>(methodName, args, false)
  }, [invokeBridge])

  return {
    bridgeReady,
    callBridge,
    callBridgeQuiet,
  }
}
