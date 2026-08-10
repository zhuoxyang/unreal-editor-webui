import { useCallback, useEffect, useState } from 'react'
import { BridgeProtocolError, type BridgeCaller } from '../bridge'
import { decodeToolCatalogBridgeResult } from '../bridge-decoders'
import {
  STARTER_TOOL_CATALOG,
  ToolCatalogDecodeError,
  decodeToolCatalogV1,
  type ToolCatalogV1,
} from '../tool-catalog'
import type { NativeToolCatalogDiagnosticCode } from '../types/bridge'

export const TOOL_CATALOG_PROJECT_PATH = 'Config/UnrealEditorWebUI/ToolCatalog.json'

export type ToolCatalogSource = 'project' | 'starter'
export type ToolCatalogLoadStatus = 'loading' | 'ready' | 'fallback'
export type ToolCatalogDiagnosticCode =
  | NativeToolCatalogDiagnosticCode
  | 'catalog_missing'
  | 'catalog_bridge_unavailable'
  | 'catalog_schema_unsupported'
  | 'catalog_schema_invalid'
  | 'catalog_transport_invalid'
  | 'catalog_load_failed'

export function toolCatalogDiagnosticMessage(code: ToolCatalogDiagnosticCode) {
  if (code === 'catalog_missing') {
    return `No project catalog was found at ${TOOL_CATALOG_PROJECT_PATH}. Using the starter catalog.`
  }
  if (code === 'catalog_bridge_unavailable') {
    return 'Runtime catalog loading is unavailable. Using the starter catalog.'
  }
  if (code === 'catalog_too_large') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} is too large. Using the starter catalog.`
  }
  if (code === 'catalog_read_failed') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} could not be read. Using the starter catalog.`
  }
  if (code === 'catalog_invalid_json') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} is not valid JSON. Using the starter catalog.`
  }
  if (code === 'catalog_invalid_encoding') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} must use valid UTF-8 without NUL bytes. Using the starter catalog.`
  }
  if (code === 'catalog_resource_limit') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} exceeds a JSON resource limit. Using the starter catalog.`
  }
  if (code === 'catalog_invalid_schema_version') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} must declare integer schemaVersion 1. Using the starter catalog.`
  }
  if (code === 'catalog_unsupported_version') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} declares an unsupported schema version. Using the starter catalog.`
  }
  if (code === 'catalog_schema_unsupported') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} uses an unsupported schema version. Using the starter catalog.`
  }
  if (code === 'catalog_schema_invalid') {
    return `The project catalog at ${TOOL_CATALOG_PROJECT_PATH} does not satisfy schema v1. Using the starter catalog.`
  }
  if (code === 'catalog_transport_invalid') {
    return 'The runtime catalog response is invalid. Using the starter catalog.'
  }
  return 'The project catalog could not be loaded. Using the starter catalog.'
}

type UseToolCatalogOptions = {
  bridgeReady: boolean
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

type CatalogResolution = {
  attempt: number
  caller: BridgeCaller
  catalog: ToolCatalogV1
  source: ToolCatalogSource
  status: Exclude<ToolCatalogLoadStatus, 'loading'>
  diagnosticCode: ToolCatalogDiagnosticCode | null
  canAutoRewrite: boolean
}

function fixedDiagnosticCode(error: unknown): ToolCatalogDiagnosticCode {
  if (error instanceof ToolCatalogDecodeError) {
    return error.code === 'catalog_unsupported_version'
      ? 'catalog_schema_unsupported'
      : 'catalog_schema_invalid'
  }
  if (error instanceof BridgeProtocolError) {
    return 'catalog_transport_invalid'
  }
  return 'catalog_load_failed'
}

export function useToolCatalog({ bridgeReady, callBridgeQuiet, log }: UseToolCatalogOptions) {
  const [attempt, setAttempt] = useState(0)
  const [resolution, setResolution] = useState<CatalogResolution | null>(null)
  const bridgeHasToolCatalog = bridgeReady && typeof window.ue?.editorwebui?.gettoolcatalog === 'function'

  useEffect(() => {
    let stopped = false
    if (!bridgeHasToolCatalog) {
      return () => {
        stopped = true
      }
    }

    void callBridgeQuiet<unknown>('gettoolcatalog')
      .then((result) => {
        if (stopped) return
        const transport = decodeToolCatalogBridgeResult(result)
        if (transport.source === 'project') {
          const catalog = decodeToolCatalogV1(transport.catalog)
          setResolution({
            attempt,
            caller: callBridgeQuiet,
            catalog,
            source: 'project',
            status: 'ready',
            diagnosticCode: null,
            canAutoRewrite: true,
          })
          return
        }

        const diagnosticCode: ToolCatalogDiagnosticCode = transport.source === 'missing'
          ? 'catalog_missing'
          : transport.diagnosticCode
        log(toolCatalogDiagnosticMessage(diagnosticCode))
        setResolution({
          attempt,
          caller: callBridgeQuiet,
          catalog: STARTER_TOOL_CATALOG,
          source: 'starter',
          status: 'fallback',
          diagnosticCode,
          canAutoRewrite: transport.source === 'missing',
        })
      })
      .catch((error: unknown) => {
        if (stopped) return
        const diagnosticCode = fixedDiagnosticCode(error)
        log(toolCatalogDiagnosticMessage(diagnosticCode))
        setResolution({
          attempt,
          caller: callBridgeQuiet,
          catalog: STARTER_TOOL_CATALOG,
          source: 'starter',
          status: 'fallback',
          diagnosticCode,
          canAutoRewrite: false,
        })
      })

    return () => {
      stopped = true
    }
  }, [attempt, bridgeHasToolCatalog, callBridgeQuiet, log])

  const retryCatalog = useCallback(() => {
    if (bridgeHasToolCatalog) {
      setAttempt((value) => value + 1)
    }
  }, [bridgeHasToolCatalog])

  if (!bridgeHasToolCatalog) {
    return {
      catalog: STARTER_TOOL_CATALOG,
      catalogReady: true,
      catalogSource: 'starter' as const,
      catalogStatus: 'fallback' as const,
      catalogDiagnosticCode: 'catalog_bridge_unavailable' as const,
      catalogDiagnostic: toolCatalogDiagnosticMessage('catalog_bridge_unavailable'),
      canAutoRewrite: true,
      canRetryCatalog: false,
      retryCatalog,
    }
  }

  const currentResolution = resolution?.caller === callBridgeQuiet && resolution.attempt === attempt
    ? resolution
    : null
  if (!currentResolution) {
    return {
      catalog: STARTER_TOOL_CATALOG,
      catalogReady: false,
      catalogSource: 'starter' as const,
      catalogStatus: 'loading' as const,
      catalogDiagnosticCode: null,
      catalogDiagnostic: '',
      canAutoRewrite: false,
      canRetryCatalog: false,
      retryCatalog,
    }
  }

  return {
    catalog: currentResolution.catalog,
    catalogReady: true,
    catalogSource: currentResolution.source,
    catalogStatus: currentResolution.status,
    catalogDiagnosticCode: currentResolution.diagnosticCode,
    catalogDiagnostic: currentResolution.diagnosticCode
      ? toolCatalogDiagnosticMessage(currentResolution.diagnosticCode)
      : '',
    canAutoRewrite: currentResolution.canAutoRewrite,
    canRetryCatalog: true,
    retryCatalog,
  }
}
