import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BridgeCallError, BridgeProtocolError, type BridgeCaller } from '../bridge'
import type { ToolPackStatusV1, ToolPackStatusV2 } from '../types/bridge'
import { toolPackStatusReasonCodes, useToolPackStatus } from './useToolPackStatus'

const STATUS: ToolPackStatusV1 = {
  statusVersion: 1,
  coreApiVersion: 1,
  packs: [],
  truncatedCount: 0,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderStatus(caller: BridgeCaller, log = vi.fn()) {
  return renderHook(() => useToolPackStatus({
    bridgeReady: true,
    commandsStatus: 'ready',
    commandAvailable: true,
    callBridgeQuiet: caller,
    log,
  }))
}

describe('useToolPackStatus', () => {
  it('waits for command discovery and distinguishes unavailable core support', () => {
    const caller = vi.fn() as BridgeCaller
    const unavailable = renderHook(() => useToolPackStatus({
      bridgeReady: false,
      commandsStatus: 'idle',
      commandAvailable: false,
      callBridgeQuiet: caller,
      log: vi.fn(),
    }))
    expect(unavailable.result.current).toMatchObject({
      toolPackStatusLoadStatus: 'unavailable',
      toolPackStatusDiagnosticCode: 'tool_pack_bridge_unavailable',
      canRetryToolPackStatus: false,
    })
    unavailable.unmount()

    const unsupported = renderHook(() => useToolPackStatus({
      bridgeReady: true,
      commandsStatus: 'ready',
      commandAvailable: false,
      callBridgeQuiet: caller,
      log: vi.fn(),
    }))
    expect(unsupported.result.current).toMatchObject({
      toolPackStatusLoadStatus: 'unsupported',
      toolPackStatusDiagnosticCode: 'tool_pack_command_unavailable',
      canRetryToolPackStatus: false,
    })
    expect(caller).not.toHaveBeenCalled()
  })

  it('loads a strictly decoded Tool Pack status snapshot', async () => {
    const caller = vi.fn().mockResolvedValue(STATUS) as BridgeCaller
    const { result } = renderStatus(caller)

    expect(result.current.toolPackStatusLoadStatus).toBe('loading')
    await waitFor(() => expect(result.current.toolPackStatusLoadStatus).toBe('ready'))
    expect(result.current.toolPackStatus).toEqual(STATUS)
    expect(caller).toHaveBeenCalledWith('executecommand', expect.stringContaining('system.toolPacks'))
  })

  it('maps unsupported, malformed, and failed requests to fixed diagnostics only', async () => {
    const secret = 'C:/Users/private/pack.py?token=secret'
    const cases: Array<{
      caller: BridgeCaller
      status: string
      code: string
    }> = [
      {
        caller: vi.fn().mockResolvedValue({ ...STATUS, statusVersion: 3, privatePath: secret }) as BridgeCaller,
        status: 'unsupported',
        code: 'tool_pack_schema_unsupported',
      },
      {
        caller: vi.fn().mockResolvedValue({ ...STATUS, privatePath: secret }) as BridgeCaller,
        status: 'malformed',
        code: 'tool_pack_response_invalid',
      },
      {
        caller: vi.fn().mockRejectedValue(
          new BridgeProtocolError('executecommand', `malformed ${secret}`, secret),
        ) as BridgeCaller,
        status: 'malformed',
        code: 'tool_pack_response_invalid',
      },
      {
        caller: vi.fn().mockRejectedValue(new Error(`load failed ${secret}`)) as BridgeCaller,
        status: 'error',
        code: 'tool_pack_request_failed',
      },
      {
        caller: vi.fn().mockRejectedValue(
          new BridgeCallError('executecommand', 'unknown_command', secret),
        ) as BridgeCaller,
        status: 'unsupported',
        code: 'tool_pack_command_unavailable',
      },
    ]

    for (const failure of cases) {
      const log = vi.fn()
      const view = renderStatus(failure.caller, log)
      await waitFor(() => expect(view.result.current.toolPackStatusLoadStatus).toBe(failure.status))
      expect(view.result.current.toolPackStatusDiagnosticCode).toBe(failure.code)
      expect(view.result.current.toolPackStatusDiagnostic).not.toContain(secret)
      expect(log.mock.calls.flat().join(' ')).not.toContain(secret)
      view.unmount()
    }
  })

  it('maps v2 backend reasons into aggregate-only support reason categories', () => {
    const status: ToolPackStatusV2 = {
      statusVersion: 2,
      coreApiVersion: 1,
      policy: {
        enforced: true,
        state: 'rejected',
        reasonCodes: ['trusted_payload_mismatch'],
      },
      packs: [{
        provider: 'studio.assets',
        packId: 'studio.assets',
        pluginName: 'StudioAssets',
        pluginVersion: '1.0.0',
        requiredCoreApi: 1,
        state: 'rejected',
        commandCount: 0,
        commands: [],
        reasonCodes: ['trusted_payload_mismatch'],
      }],
      truncatedCount: 0,
    }

    expect(toolPackStatusReasonCodes(status)).toEqual(['tool_pack_load_rejected'])
    expect(JSON.stringify(toolPackStatusReasonCodes(status))).not.toContain('studio.assets')
  })

  it('retries a transient failure and ignores a stale caller response', async () => {
    const recovering = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(STATUS) as BridgeCaller
    const recovery = renderStatus(recovering)
    await waitFor(() => expect(recovery.result.current.toolPackStatusLoadStatus).toBe('error'))
    act(() => recovery.result.current.retryToolPackStatus())
    await waitFor(() => expect(recovery.result.current.toolPackStatusLoadStatus).toBe('ready'))
    expect(recovering).toHaveBeenCalledTimes(2)
    recovery.unmount()

    const stale = deferred<unknown>()
    const firstCaller = vi.fn().mockReturnValue(stale.promise) as BridgeCaller
    const currentStatus = { ...STATUS, truncatedCount: 3 }
    const secondCaller = vi.fn().mockResolvedValue(currentStatus) as BridgeCaller
    const log = vi.fn()
    const { result, rerender } = renderHook(
      ({ caller }: { caller: BridgeCaller }) => useToolPackStatus({
        bridgeReady: true,
        commandsStatus: 'ready',
        commandAvailable: true,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps: { caller: firstCaller } },
    )
    await waitFor(() => expect(firstCaller).toHaveBeenCalledOnce())
    rerender({ caller: secondCaller })
    await waitFor(() => expect(result.current.toolPackStatus).toEqual(currentStatus))
    await act(async () => {
      stale.resolve(STATUS)
      await stale.promise
    })
    expect(result.current.toolPackStatus).toEqual(currentStatus)
  })

  it('starts a new loading generation after registry loading or error re-entry', async () => {
    const fromLoading = deferred<unknown>()
    const fromError = deferred<unknown>()
    const caller = vi.fn()
      .mockResolvedValueOnce(STATUS)
      .mockReturnValueOnce(fromLoading.promise)
      .mockReturnValueOnce(fromError.promise) as BridgeCaller
    const log = vi.fn()
    type RegistryProps = { commandsStatus: 'loading' | 'ready' | 'error' }
    const initialProps: RegistryProps = { commandsStatus: 'ready' }
    const { result, rerender } = renderHook(
      ({ commandsStatus }: RegistryProps) => useToolPackStatus({
        bridgeReady: true,
        commandsStatus,
        commandAvailable: true,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps },
    )

    await waitFor(() => expect(result.current.toolPackStatusLoadStatus).toBe('ready'))
    rerender({ commandsStatus: 'loading' })
    expect(result.current).toMatchObject({
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading',
    })
    rerender({ commandsStatus: 'ready' })
    expect(result.current).toMatchObject({
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading',
    })
    expect(caller).toHaveBeenCalledTimes(2)
    await act(async () => {
      fromLoading.resolve({ ...STATUS, truncatedCount: 1 })
      await fromLoading.promise
    })
    await waitFor(() => expect(result.current.toolPackStatus?.truncatedCount).toBe(1))

    rerender({ commandsStatus: 'error' })
    expect(result.current).toMatchObject({
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'error',
      toolPackStatusDiagnosticCode: 'tool_pack_registry_unavailable',
    })
    rerender({ commandsStatus: 'ready' })
    expect(result.current).toMatchObject({
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading',
    })
    expect(caller).toHaveBeenCalledTimes(3)
    await act(async () => {
      fromError.resolve({ ...STATUS, truncatedCount: 2 })
      await fromError.promise
    })
    await waitFor(() => expect(result.current.toolPackStatus?.truncatedCount).toBe(2))
  })

  it('starts a new loading generation after command availability re-entry', async () => {
    const reentry = deferred<unknown>()
    const caller = vi.fn()
      .mockResolvedValueOnce(STATUS)
      .mockReturnValueOnce(reentry.promise) as BridgeCaller
    const log = vi.fn()
    const { result, rerender } = renderHook(
      ({ commandAvailable }: { commandAvailable: boolean }) => useToolPackStatus({
        bridgeReady: true,
        commandsStatus: 'ready',
        commandAvailable,
        callBridgeQuiet: caller,
        log,
      }),
      { initialProps: { commandAvailable: true } },
    )

    await waitFor(() => expect(result.current.toolPackStatusLoadStatus).toBe('ready'))
    rerender({ commandAvailable: false })
    expect(result.current.toolPackStatusLoadStatus).toBe('unsupported')
    rerender({ commandAvailable: true })
    expect(result.current).toMatchObject({
      toolPackStatus: null,
      toolPackStatusLoadStatus: 'loading',
    })
    expect(caller).toHaveBeenCalledTimes(2)

    await act(async () => {
      reentry.resolve({ ...STATUS, truncatedCount: 3 })
      await reentry.promise
    })
    await waitFor(() => expect(result.current.toolPackStatus?.truncatedCount).toBe(3))
  })
})
