import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeProtocolError, type BridgeCaller } from '../bridge'
import type { WebUIHealth } from '../types/bridge'
import { useWebUIHealth } from './useWebUIHealth'

const HEALTH: WebUIHealth = {
  protocolVersion: 1,
  bridgeProtocolVersion: 1,
  pluginVersion: '0.1.1',
  engineVersion: '5.8.0',
  documentScope: 'packaged',
  pythonRuntime: 'available',
  privilegedConfirmation: 'per_call',
  taskSessionIsolation: 'document',
}

function installBridge(withHealth = true) {
  window.ue = {
    editorwebui: {
      executecommand: vi.fn(),
      startcommand: vi.fn(),
      gettask: vi.fn(),
      listtasks: vi.fn(),
      removetask: vi.fn(),
      canceltask: vi.fn(),
      getwebuisettings: vi.fn(),
      setwebuisettings: vi.fn(),
      ...(withHealth ? { getwebuihealth: vi.fn() } : {}),
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  delete window.ue
})

describe('useWebUIHealth', () => {
  it('distinguishes an unavailable bridge from an older unsupported bridge', () => {
    const caller = vi.fn() as BridgeCaller
    const log = vi.fn()
    const unavailable = renderHook(() => useWebUIHealth({
      bridgeReady: false,
      callBridgeQuiet: caller,
      log,
    }))

    expect(unavailable.result.current).toMatchObject({
      health: null,
      healthStatus: 'unavailable',
      healthDiagnosticCode: 'health_bridge_unavailable',
      canRetryHealth: false,
    })
    unavailable.unmount()

    installBridge(false)
    const unsupported = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: caller,
      log,
    }))
    expect(unsupported.result.current).toMatchObject({
      health: null,
      healthStatus: 'unsupported',
      healthDiagnosticCode: 'health_method_unavailable',
      canRetryHealth: false,
    })
    expect(caller).not.toHaveBeenCalled()
  })

  it('loads and strictly decodes a health snapshot', async () => {
    installBridge()
    const caller = vi.fn().mockResolvedValue(HEALTH) as BridgeCaller
    const { result } = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: caller,
      log: vi.fn(),
    }))

    expect(result.current.healthStatus).toBe('loading')
    await waitFor(() => expect(result.current.healthStatus).toBe('ready'))
    expect(result.current.health).toEqual(HEALTH)
    expect(caller).toHaveBeenCalledWith('getwebuihealth')
  })

  it('maps transport and request failures to fixed diagnostics without exposing raw errors', async () => {
    installBridge()
    const secret = 'C:/Users/private/token-secret'
    const log = vi.fn()
    const protocolCaller = vi.fn().mockRejectedValue(
      new BridgeProtocolError('getwebuihealth', `malformed ${secret}`, secret),
    ) as BridgeCaller
    const protocol = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: protocolCaller,
      log,
    }))

    await waitFor(() => expect(protocol.result.current.healthStatus).toBe('error'))
    expect(protocol.result.current.healthDiagnosticCode).toBe('health_transport_invalid')
    expect(protocol.result.current.healthDiagnostic).not.toContain(secret)
    expect(log.mock.calls.flat().join(' ')).not.toContain(secret)
    protocol.unmount()

    const requestCaller = vi.fn().mockRejectedValue(new Error(`native failure ${secret}`)) as BridgeCaller
    const request = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: requestCaller,
      log,
    }))
    await waitFor(() => expect(request.result.current.healthStatus).toBe('error'))
    expect(request.result.current.healthDiagnosticCode).toBe('health_request_failed')
    expect(request.result.current.healthDiagnostic).not.toContain(secret)
    expect(log.mock.calls.flat().join(' ')).not.toContain(secret)
  })

  it('retries after a failure and recovers with a valid snapshot', async () => {
    installBridge()
    const log = vi.fn()
    const caller = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(HEALTH) as BridgeCaller
    const { result } = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: caller,
      log,
    }))

    await waitFor(() => expect(result.current.healthStatus).toBe('error'))
    act(() => result.current.retryHealth())
    await waitFor(() => expect(result.current.healthStatus).toBe('ready'))
    expect(result.current.health).toEqual(HEALTH)
    expect(caller).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale response from an earlier retry attempt', async () => {
    installBridge()
    const stale = deferred<unknown>()
    const currentHealth: WebUIHealth = { ...HEALTH, documentScope: 'loopback_http' }
    const caller = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(currentHealth) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useWebUIHealth({
      bridgeReady: true,
      callBridgeQuiet: caller,
      log,
    }))

    await waitFor(() => expect(caller).toHaveBeenCalledOnce())
    act(() => result.current.retryHealth())
    await waitFor(() => expect(result.current.health).toEqual(currentHealth))

    await act(async () => {
      stale.resolve({ ...HEALTH, documentScope: 'inactive' })
      await stale.promise
    })
    expect(result.current.health).toEqual(currentHealth)
    expect(caller).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale response after the bridge caller changes', async () => {
    installBridge()
    const stale = deferred<unknown>()
    const firstCaller = vi.fn().mockReturnValue(stale.promise) as BridgeCaller
    const secondHealth: WebUIHealth = {
      ...HEALTH,
      documentScope: 'loopback_https',
      pythonRuntime: 'unavailable',
    }
    const secondCaller = vi.fn().mockResolvedValue(secondHealth) as BridgeCaller
    const log = vi.fn()
    const { result, rerender } = renderHook(
      ({ caller }: { caller: BridgeCaller }) => useWebUIHealth({
        bridgeReady: true,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps: { caller: firstCaller } },
    )

    await waitFor(() => expect(firstCaller).toHaveBeenCalledOnce())
    rerender({ caller: secondCaller })
    await waitFor(() => expect(result.current.healthStatus).toBe('ready'))
    expect(result.current.health).toEqual(secondHealth)

    await act(async () => {
      stale.resolve({ ...HEALTH, documentScope: 'inactive' })
      await stale.promise
    })
    expect(result.current.health).toEqual(secondHealth)
  })
})
