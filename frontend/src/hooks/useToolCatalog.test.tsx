import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { TOOL_CATALOG_PROJECT_PATH, useToolCatalog } from './useToolCatalog'

function customCatalog() {
  return {
    schemaVersion: 1,
    projects: [{ id: 'project-custom', name: 'Custom Project', stages: ['stage-custom'] }],
    stages: [{ id: 'stage-custom', label: 'Custom Stage' }],
    categories: [
      { id: 'all', label: 'All', icon: 'grid' },
      { id: 'favorites', label: 'Favorites', icon: 'star' },
      { id: 'recent', label: 'Recent', icon: 'recent' },
      { id: 'category-custom', label: 'Custom', icon: 'assets' },
    ],
    defaultPreferences: {
      projectId: 'project-custom',
      stageId: 'stage-custom',
      categoryId: 'category-custom',
      favorites: [],
      openTabs: [],
    },
  }
}

function projectTransport(catalog: unknown = customCatalog()) {
  return {
    protocolVersion: 1,
    source: 'project',
    catalog,
    diagnosticCode: null,
  }
}

describe('useToolCatalog', () => {
  afterEach(() => {
    delete window.ue
  })

  it('uses the starter catalog for static or older bridge paths', () => {
    window.ue = { editorwebui: {} as never }
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({
      bridgeReady: true,
      callBridgeQuiet: vi.fn() as BridgeCaller,
      log,
    }))

    expect(result.current).toMatchObject({
      catalogReady: true,
      catalogSource: 'starter',
      catalogStatus: 'fallback',
      catalogDiagnosticCode: 'catalog_bridge_unavailable',
      canAutoRewrite: true,
    })
  })

  it('loads and decodes a valid project catalog', async () => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    const callBridgeQuiet = vi.fn().mockResolvedValue(projectTransport()) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    expect(result.current.catalogStatus).toBe('loading')
    await waitFor(() => expect(result.current.catalogSource).toBe('project'))
    expect(result.current.catalog.defaultPreferences).toMatchObject({
      projectId: 'project-custom',
      stageId: 'stage-custom',
      categoryId: 'category-custom',
    })
    expect(result.current.catalogDiagnostic).toBe('')
    expect(result.current.canAutoRewrite).toBe(true)
  })

  it('uses the starter for a missing catalog but permits normal preference reconciliation', async () => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      source: 'missing',
      catalog: null,
      diagnosticCode: null,
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.catalogDiagnosticCode).toBe('catalog_missing'))
    expect(result.current.catalogDiagnostic).toContain(TOOL_CATALOG_PROJECT_PATH)
    expect(result.current.canAutoRewrite).toBe(true)
  })

  it.each([
    'catalog_invalid_encoding',
    'catalog_resource_limit',
    'catalog_invalid_schema_version',
    'catalog_unsupported_version',
  ] as const)('maps native %s diagnostics to fixed UI text and disables automatic rewrites', async (diagnosticCode) => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      source: 'invalid',
      catalog: null,
      diagnosticCode,
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.catalogDiagnosticCode).toBe(diagnosticCode))
    expect(result.current.catalogDiagnostic).toContain(TOOL_CATALOG_PROJECT_PATH)
    expect(result.current.canAutoRewrite).toBe(false)
  })

  it('does not expose raw schema or transport errors in the fallback diagnostic', async () => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    const secretPath = 'C:/Users/private/secret-catalog.json'
    const callBridgeQuiet = vi.fn().mockResolvedValue(projectTransport({
      ...customCatalog(),
      unexpectedPath: secretPath,
    })) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({ bridgeReady: true, callBridgeQuiet, log }))

    await waitFor(() => expect(result.current.catalogDiagnosticCode).toBe('catalog_schema_invalid'))
    expect(result.current.catalogDiagnostic).not.toContain(secretPath)
    expect(JSON.stringify(log.mock.calls)).not.toContain(secretPath)
    expect(result.current.canAutoRewrite).toBe(false)
  })

  it('retries an invalid catalog and replaces it with a valid project catalog', async () => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    const callBridgeQuiet = vi.fn()
      .mockResolvedValueOnce({
        protocolVersion: 1,
        source: 'invalid',
        catalog: null,
        diagnosticCode: 'catalog_invalid_json',
      })
      .mockResolvedValueOnce(projectTransport()) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useToolCatalog({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.catalogDiagnosticCode).toBe('catalog_invalid_json'))
    act(() => result.current.retryCatalog())
    await waitFor(() => expect(result.current.catalogSource).toBe('project'))
    expect(callBridgeQuiet).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale response after the bridge caller changes', async () => {
    window.ue = { editorwebui: { gettoolcatalog: vi.fn() } as never }
    let resolveFirst!: (value: unknown) => void
    const firstCaller = vi.fn(() => new Promise((resolve) => {
      resolveFirst = resolve
    })) as BridgeCaller
    const secondCaller = vi.fn().mockResolvedValue(projectTransport()) as BridgeCaller
    const log = vi.fn()
    const { result, rerender } = renderHook(
      ({ caller }: { caller: BridgeCaller }) => useToolCatalog({
        bridgeReady: true,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps: { caller: firstCaller } },
    )

    rerender({ caller: secondCaller })
    await waitFor(() => expect(result.current.catalogSource).toBe('project'))
    resolveFirst({
      protocolVersion: 1,
      source: 'invalid',
      catalog: null,
      diagnosticCode: 'catalog_invalid_json',
    })
    await act(async () => Promise.resolve())
    expect(result.current.catalogSource).toBe('project')
  })
})
