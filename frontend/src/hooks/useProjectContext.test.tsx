import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { useProjectContext } from './useProjectContext'

describe('useProjectContext', () => {
  afterEach(() => {
    delete window.ue
  })

  it('uses a decoded native project namespace when available', async () => {
    window.ue = { editorwebui: { getprojectcontext: vi.fn() } as never }
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      projectName: 'Example',
      storageNamespace: 'project-a1b2',
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useProjectContext({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.projectContextReady).toBe(true))
    expect(result.current.projectContext.storageNamespace).toBe('project-a1b2')
  })

  it('falls back without reading a global namespace when the method is unavailable', () => {
    window.ue = { editorwebui: {} as never }
    const log = vi.fn()
    const { result } = renderHook(() => useProjectContext({
      bridgeReady: true,
      callBridgeQuiet: vi.fn() as BridgeCaller,
      log,
    }))

    expect(result.current.projectContextReady).toBe(true)
    expect(result.current.projectContext).toMatchObject({
      storageNamespace: null,
      persistenceEnabled: false,
    })
  })

  it('fails closed when project context lookup fails', async () => {
    window.ue = { editorwebui: { getprojectcontext: vi.fn() } as never }
    const log = vi.fn()
    const callBridgeQuiet = vi.fn().mockRejectedValue(new Error('context unavailable')) as BridgeCaller
    const { result } = renderHook(() => useProjectContext({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.projectContextReady).toBe(true))
    expect(result.current.projectContext).toMatchObject({ storageNamespace: null, persistenceEnabled: false })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('context unavailable'))
  })

  it('invalidates an old namespace immediately when the bridge caller changes', async () => {
    window.ue = { editorwebui: { getprojectcontext: vi.fn() } as never }
    const firstCaller = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      projectName: 'First',
      storageNamespace: 'project-first',
    }) as BridgeCaller
    let resolveSecond!: (value: unknown) => void
    const secondCaller = vi.fn(() => new Promise((resolve) => {
      resolveSecond = resolve
    })) as BridgeCaller
    const log = vi.fn()
    const { result, rerender } = renderHook(
      ({ caller }: { caller: BridgeCaller }) => useProjectContext({
        bridgeReady: true,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps: { caller: firstCaller } },
    )

    await waitFor(() => expect(result.current.projectContext.storageNamespace).toBe('project-first'))
    rerender({ caller: secondCaller })

    expect(result.current.projectContextReady).toBe(false)
    expect(result.current.projectContext).toMatchObject({
      storageNamespace: null,
      persistenceEnabled: false,
    })

    resolveSecond({
      protocolVersion: 1,
      projectName: 'Second',
      storageNamespace: 'project-second',
    })
    await waitFor(() => expect(result.current.projectContext.storageNamespace).toBe('project-second'))
  })
})
