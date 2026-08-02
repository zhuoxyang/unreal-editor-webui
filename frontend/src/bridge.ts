import { useCallback, useEffect, useState } from 'react'
import type {
  BridgeErrorData,
  BridgeResponse,
  ChangeSetErrorOperation,
  ChangeSetOperationStatus,
} from './types/bridge'

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
const MAX_ERROR_DATA_OPERATIONS = 200
const CHANGE_SET_OPERATION_STATUSES = new Set<string>([
  'skipped',
  'failed',
  'changed',
  'changed_unsaved',
])
const CHANGE_SET_SUMMARY_STATUSES = new Set<string>([
  'preview',
  'partial',
  'failed',
  'completed',
  'no_changes',
])

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

function invalidErrorData(
  methodName: BridgeMethodName,
  message: string,
  preview?: string,
): never {
  throw new BridgeProtocolError(methodName, `field "error.data" ${message}`, preview)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function decodeChangeSetOperation(
  methodName: BridgeMethodName,
  value: unknown,
  preview?: string,
): ChangeSetErrorOperation {
  if (!isRecord(value)) {
    return invalidErrorData(methodName, 'contains a non-object change-set operation.', preview)
  }

  const { assetPath, propertyPath, action, status, message } = value
  if (
    typeof assetPath !== 'string'
    || typeof propertyPath !== 'string'
    || typeof action !== 'string'
    || typeof message !== 'string'
    || typeof status !== 'string'
    || !CHANGE_SET_OPERATION_STATUSES.has(status)
    || !Object.prototype.hasOwnProperty.call(value, 'before')
    || !Object.prototype.hasOwnProperty.call(value, 'after')
  ) {
    return invalidErrorData(methodName, 'contains an invalid change-set operation.', preview)
  }

  return {
    assetPath,
    propertyPath,
    before: value.before,
    after: value.after,
    action,
    status: status as ChangeSetOperationStatus,
    message,
  }
}

function decodeBridgeErrorData(
  methodName: BridgeMethodName,
  value: unknown,
  preview?: string,
): BridgeErrorData {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.view !== 'changeSet') {
    return invalidErrorData(methodName, 'must be a supported changeSet v1 object.', preview)
  }
  if (!isRecord(value.summary) || !Array.isArray(value.changeSet)) {
    return invalidErrorData(methodName, 'requires object "summary" and array "changeSet" fields.', preview)
  }
  if (value.changeSet.length > MAX_ERROR_DATA_OPERATIONS) {
    return invalidErrorData(
      methodName,
      `contains more than ${MAX_ERROR_DATA_OPERATIONS} change-set operations.`,
      preview,
    )
  }

  const summary = value.summary
  const {
    label,
    dryRun,
    save,
    status,
    changed,
    changedUnsaved,
    skipped,
    failed,
    total,
  } = summary
  if (
    typeof label !== 'string'
    || typeof dryRun !== 'boolean'
    || typeof save !== 'boolean'
    || typeof status !== 'string'
    || !CHANGE_SET_SUMMARY_STATUSES.has(status)
    || !isNonNegativeInteger(changed)
    || !isNonNegativeInteger(changedUnsaved)
    || !isNonNegativeInteger(skipped)
    || !isNonNegativeInteger(failed)
    || !isNonNegativeInteger(total)
  ) {
    return invalidErrorData(methodName, 'contains an invalid change-set summary.', preview)
  }

  const changeSet = value.changeSet.map((operation) => (
    decodeChangeSetOperation(methodName, operation, preview)
  ))
  const actualCounts = {
    changed: changeSet.filter((operation) => operation.status === 'changed').length,
    changedUnsaved: changeSet.filter((operation) => operation.status === 'changed_unsaved').length,
    skipped: changeSet.filter((operation) => operation.status === 'skipped').length,
    failed: changeSet.filter((operation) => operation.status === 'failed').length,
  }
  if (
    total !== changeSet.length
    || changed + changedUnsaved + skipped + failed !== total
    || changed !== actualCounts.changed
    || changedUnsaved !== actualCounts.changedUnsaved
    || skipped !== actualCounts.skipped
    || failed !== actualCounts.failed
  ) {
    return invalidErrorData(methodName, 'has inconsistent change-set summary counts.', preview)
  }

  return {
    protocolVersion: 1,
    view: 'changeSet',
    summary: {
      label,
      dryRun,
      save,
      status: status as BridgeErrorData['summary']['status'],
      changed,
      changedUnsaved,
      skipped,
      failed,
      total,
    },
    changeSet,
  }
}

export class BridgeCallError extends Error {
  readonly methodName: BridgeMethodName
  readonly code: string
  readonly details?: string[]
  readonly requestId: string | null
  readonly data?: BridgeErrorData

  constructor(
    methodName: BridgeMethodName,
    code: string,
    message: string,
    details?: string[],
    requestId: string | null = null,
    data?: BridgeErrorData,
  ) {
    super(message)
    this.name = 'BridgeCallError'
    this.methodName = methodName
    this.code = code
    this.details = details
    this.requestId = requestId
    this.data = data
  }
}

function structuredErrorDetails(data?: BridgeErrorData) {
  if (!data) {
    return []
  }

  const details: string[] = []
  for (const operation of data.changeSet) {
    if (operation.status === 'failed') {
      details.push(`${operation.assetPath || 'Operation'}: ${operation.message}`)
      if (details.length === 3) break
    }
  }
  return details
}

export function formatBridgeError(error: unknown) {
  if (error instanceof BridgeCallError) {
    const visibleDetails = (error.details || []).slice(0, 3)
    if (visibleDetails.length < 3) {
      visibleDetails.push(...structuredErrorDetails(error.data).slice(0, 3 - visibleDetails.length))
    }
    const details = visibleDetails.map(boundedErrorDetail).join('; ')
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

  const { code, message, details, data, traceback } = parsed.error
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
  const decodedData = data === undefined ? undefined : decodeBridgeErrorData(methodName, data, preview)
  if (traceback !== undefined && typeof traceback !== 'string') {
    throw new BridgeProtocolError(methodName, 'field "error.traceback" must be a string.', preview)
  }

  return {
    id: parsed.id as string | null,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details: details as string[] }),
      ...(decodedData === undefined ? {} : { data: decodedData }),
      ...(traceback === undefined ? {} : { traceback }),
    },
  }
}

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useEditorBridge(log?: (message: string) => void) {
  const [bridge, setBridge] = useState<EditorWebUIBridge | undefined>(() => window.ue?.editorwebui)
  const bridgeReady = Boolean(bridge)

  useEffect(() => {
    function refreshBridge() {
      setBridge(window.ue?.editorwebui)
    }

    refreshBridge()
    document.addEventListener('ue:ready', refreshBridge)
    return () => document.removeEventListener('ue:ready', refreshBridge)
  }, [])

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
        response.error.data,
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
