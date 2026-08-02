import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BridgeCallError, type BridgeCaller } from '../bridge'
import type { ChangeSetErrorData } from '../types/bridge'
import type { CommandMetadata } from '../types/command'
import { useCommandRunner } from './useCommandRunner'

const command: CommandMetadata = {
  name: 'asset.scan',
  description: 'Scan assets.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function renderRunner(callBridge: BridgeCaller) {
  const log = vi.fn()
  const mergeTaskResult = vi.fn()
  const recordRecentExecution = vi.fn()
  const hook = renderHook(() => useCommandRunner({
    buildPayload: () => ({ path: '/Game/A' }),
    callBridge,
    log,
    mergeTaskResult,
    recordRecentExecution,
  }))
  return { ...hook, log, mergeTaskResult, recordRecentExecution }
}

describe('useCommandRunner', () => {
  it('keeps each command single-flight and disables duplicate dispatch', async () => {
    const pending = deferred<unknown>()
    const callBridge = vi.fn(() => pending.promise) as BridgeCaller
    const { result } = renderRunner(callBridge)

    let first!: Promise<void>
    await act(async () => {
      first = result.current.runCommandFromMetadata(command)
      void result.current.runCommandFromMetadata(command)
      await Promise.resolve()
    })

    expect(callBridge).toHaveBeenCalledOnce()
    expect(result.current.commandInvocations[command.name]).toMatchObject({ status: 'pending', stale: false })

    pending.resolve({ assets: [] })
    await act(async () => first)
    expect(result.current.commandInvocations[command.name]).toMatchObject({ status: 'success', stale: false })
  })

  it('keeps the last success visibly stale when a later run fails', async () => {
    const callBridge = vi.fn()
      .mockResolvedValueOnce({ value: 'first' })
      .mockRejectedValueOnce(new Error('second run failed')) as BridgeCaller
    const { result } = renderRunner(callBridge)

    await act(async () => result.current.runCommandFromMetadata(command))
    expect(result.current.commandResults[command.name]).toEqual({ value: 'first' })

    await act(async () => result.current.runCommandFromMetadata(command))
    expect(result.current.commandResults[command.name]).toEqual({ value: 'first' })
    expect(result.current.commandInvocations[command.name]).toMatchObject({
      status: 'error',
      stale: true,
      error: 'second run failed',
    })
  })

  it('renders structured command failure data instead of keeping a stale success', async () => {
    const failureData: ChangeSetErrorData = {
      protocolVersion: 1,
      view: 'changeSet',
      summary: {
        label: 'asset.renameBatch',
        dryRun: false,
        save: false,
        status: 'failed',
        changed: 0,
        changedUnsaved: 0,
        skipped: 0,
        failed: 1,
        total: 1,
      },
      changeSet: [{
        assetPath: '/Game/Props/SM_OldChair',
        propertyPath: 'objectPath',
        before: '/Game/Props/SM_OldChair',
        after: '/Game/Props/SM_NewChair',
        action: 'rename',
        status: 'failed',
        message: 'Unreal rejected the asset rename.',
      }],
    }
    const callBridge = vi.fn()
      .mockResolvedValueOnce({ value: 'first' })
      .mockRejectedValueOnce(new BridgeCallError(
        'executecommand',
        'batch_failed',
        'No asset could be changed.',
        undefined,
        'req-4',
        failureData,
      )) as BridgeCaller
    const { result } = renderRunner(callBridge)

    await act(async () => result.current.runCommandFromMetadata(command))
    await act(async () => result.current.runCommandFromMetadata(command))

    expect(result.current.commandResults[command.name]).toEqual(failureData)
    expect(result.current.commandInvocations[command.name]).toMatchObject({
      status: 'error',
      stale: false,
      error: expect.stringContaining('/Game/Props/SM_OldChair'),
    })
  })

  it('rejects malformed task results before merging them into UI state', async () => {
    const callBridge = vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'running', logs: 'broken' }) as BridgeCaller
    const { result, mergeTaskResult } = renderRunner(callBridge)

    await act(async () => result.current.startTaskFromMetadata(command))

    expect(mergeTaskResult).not.toHaveBeenCalled()
    expect(result.current.commandInvocations[command.name]).toMatchObject({ status: 'error' })
    expect(result.current.commandInvocations[command.name].error).toContain('field "logs"')
  })
})
