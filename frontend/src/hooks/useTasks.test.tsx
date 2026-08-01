import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { useTasks } from './useTasks'

function bridgeCaller(resultByMethod: Record<string, unknown>): BridgeCaller {
  return vi.fn(async (methodName: string) => {
    const result = resultByMethod[methodName]
    if (result instanceof Error) {
      throw result
    }
    return result
  }) as BridgeCaller
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTasks', () => {
  it('restores with one list call and applies pushed events immediately', async () => {
    const callBridgeQuiet = bridgeCaller({
      listtasks: {
        tasks: [
          {
            taskId: 'task-1',
            command: 'asset.scan',
            payload: {},
            status: 'running',
            progress: 10,
            updatedAt: '2026-07-07T05:00:00Z',
          },
          { taskId: 'task-2', command: 'asset.scan', payload: {}, status: 'queued', progress: 0 },
        ],
      },
    })
    const { result, unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await waitFor(() => expect(result.current.taskList).toHaveLength(2))
    expect(callBridgeQuiet).toHaveBeenCalledTimes(1)
    expect(callBridgeQuiet).toHaveBeenCalledWith('listtasks')
    expect(callBridgeQuiet).not.toHaveBeenCalledWith('gettask', expect.anything())

    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: {
          type: 'task.status',
          taskId: 'task-1',
          status: 'completed',
          progress: 100,
          log: 'done',
          updatedAt: '2026-07-07T06:00:00Z',
        },
      }))
    })

    expect(result.current.taskRecords['task-1'].status).toBe('completed')
    expect(result.current.eventLines[0]).toContain('task.status task-1 completed 100% done')
    unmount()
  })

  it('does not let an in-flight stale snapshot overwrite a newer event', async () => {
    const snapshot = deferred<unknown>()
    const callBridgeQuiet = vi.fn(async () => snapshot.promise) as BridgeCaller
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: {
          type: 'task.status',
          taskId: 'task-stale',
          status: 'completed',
          progress: 100,
          log: 'completed by event',
        },
      }))
    })

    await act(async () => {
      snapshot.resolve({
        tasks: [{
          taskId: 'task-stale',
          command: 'asset.longScan',
          payload: { path: '/Game' },
          status: 'running',
          progress: 20,
        }],
      })
      await flushPromises()
    })

    expect(result.current.taskRecords['task-stale']).toMatchObject({
      command: 'asset.longScan',
      status: 'completed',
      progress: 100,
      logs: ['completed by event'],
    })
  })

  it('ignores out-of-order lifecycle updates for the same status', async () => {
    const callBridgeQuiet = bridgeCaller({
      listtasks: {
        tasks: [{
          taskId: 'task-progress',
          status: 'running',
          progress: 80,
          message: 'newer update',
          logs: ['step 8'],
          updatedAt: '2026-07-31T08:00:00Z',
        }],
      },
    })
    const { result, unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await waitFor(() => expect(result.current.taskRecords['task-progress']).toBeDefined())
    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: {
          type: 'task.status',
          taskId: 'task-progress',
          status: 'running',
          progress: 20,
          message: 'older update',
          log: 'step 2',
          updatedAt: '2026-07-31T07:00:00Z',
        },
      }))
    })

    expect(result.current.taskRecords['task-progress']).toMatchObject({
      progress: 80,
      message: 'newer update',
      logs: ['step 8'],
      updatedAt: '2026-07-31T08:00:00Z',
    })
    unmount()
  })

  it('lets an authoritative terminal snapshot enrich an event-created terminal state', async () => {
    vi.useFakeTimers()
    const callBridgeQuiet = vi.fn()
      .mockResolvedValueOnce({
        tasks: [{
          taskId: 'task-terminal',
          status: 'running',
          progress: 50,
          logs: ['started'],
          updatedAt: '2026-07-31T07:00:00Z',
        }],
      })
      .mockResolvedValueOnce({
        tasks: [{
          taskId: 'task-terminal',
          status: 'completed',
          progress: 100,
          logs: ['started', 'finished'],
          responseJson: '{"id":null,"ok":true,"result":{"done":true}}',
          updatedAt: '2026-07-31T07:59:59Z',
        }],
      }) as BridgeCaller
    const { result, unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await act(flushPromises)
    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: {
          type: 'task.status',
          taskId: 'task-terminal',
          status: 'completed',
          progress: 100,
          log: 'finished',
          updatedAt: '2026-07-31T08:00:00Z',
        },
      }))
    })

    await act(async () => {
      vi.advanceTimersByTime(15_000)
      await flushPromises()
    })
    expect(result.current.taskRecords['task-terminal']).toMatchObject({
      status: 'completed',
      logs: ['started', 'finished'],
      responseJson: '{"id":null,"ok":true,"result":{"done":true}}',
      updatedAt: '2026-07-31T07:59:59Z',
    })
    unmount()
  })

  it('uses one periodic list request regardless of active task count', async () => {
    vi.useFakeTimers()
    const tasks = Array.from({ length: 20 }, (_, index) => ({
      taskId: `task-${index}`,
      status: 'running',
      progress: index,
    }))
    const listTasks = vi.fn(async (methodName: string) => {
      expect(methodName).toBe('listtasks')
      return { tasks }
    })
    const callBridgeQuiet = listTasks as BridgeCaller
    const { unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await act(flushPromises)
    expect(callBridgeQuiet).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(15_000)
      await flushPromises()
    })
    expect(callBridgeQuiet).toHaveBeenCalledTimes(2)
    expect(listTasks.mock.calls.every(([methodName]) => methodName === 'listtasks')).toBe(true)
    unmount()
  })

  it('prevents a stale snapshot and late event from reviving a removed task', async () => {
    vi.useFakeTimers()
    const staleSnapshot = deferred<unknown>()
    const callBridgeQuiet = vi.fn()
      .mockResolvedValueOnce({
        tasks: [{ taskId: 'task-remove', status: 'completed', progress: 100 }],
      })
      .mockImplementationOnce(async () => staleSnapshot.promise) as BridgeCaller
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({ removetask: { taskId: 'task-remove', removed: true } }),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await act(flushPromises)
    expect(result.current.taskRecords['task-remove']).toBeDefined()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await flushPromises()
    })
    expect(callBridgeQuiet).toHaveBeenCalledTimes(2)

    await act(async () => {
      await result.current.removeTask('task-remove')
    })
    expect(result.current.taskRecords['task-remove']).toBeUndefined()

    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: { type: 'task.status', taskId: 'task-remove', status: 'completed' },
      }))
    })
    await act(async () => {
      staleSnapshot.resolve({
        tasks: [{ taskId: 'task-remove', status: 'completed', progress: 100 }],
      })
      await flushPromises()
    })

    expect(result.current.taskRecords['task-remove']).toBeUndefined()
  })

  it('keeps a task when the bridge does not confirm removal', async () => {
    const log = vi.fn()
    const callBridgeQuiet = bridgeCaller({
      listtasks: {
        tasks: [{ taskId: 'task-not-removed', status: 'completed', progress: 100 }],
      },
    })
    const { result, unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({ removetask: { taskId: 'task-not-removed', removed: false } }),
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.taskRecords['task-not-removed']).toBeDefined())
    await act(async () => {
      await result.current.removeTask('task-not-removed')
    })

    expect(result.current.taskRecords['task-not-removed']).toBeDefined()
    expect(result.current.taskRecords['task-not-removed'].lastError).toContain('did not confirm removal')
    expect(log).toHaveBeenCalledWith('Bridge did not confirm removal for task: task-not-removed')
    unmount()
  })

  it('backs off after reconciliation failure without changing task state', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const callBridgeQuiet = vi.fn()
      .mockRejectedValueOnce(new Error('temporary bridge failure'))
      .mockResolvedValueOnce({
        tasks: [{ taskId: 'task-recovered', status: 'running', progress: 25 }],
      }) as BridgeCaller
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log,
    }))

    await act(flushPromises)
    expect(log).toHaveBeenCalledWith('Unable to reconcile tasks: temporary bridge failure')
    expect(callBridgeQuiet).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_999)
      await flushPromises()
    })
    expect(callBridgeQuiet).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await flushPromises()
    })
    expect(callBridgeQuiet).toHaveBeenCalledTimes(2)
    expect(result.current.taskRecords['task-recovered'].status).toBe('running')
  })

  it('pauses reconciliation while hidden and refreshes when visible again', async () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = 'visible'
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState)
    const listTasks = vi.fn(async (methodName: string) => {
      expect(methodName).toBe('listtasks')
      return {
        tasks: [{ taskId: 'task-visible', status: 'running', progress: 10 }],
      }
    })
    const { unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet: listTasks as BridgeCaller,
      log: vi.fn(),
    }))

    await act(flushPromises)
    expect(listTasks).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(60_000)
    })
    expect(listTasks).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()
    })
    expect(listTasks).toHaveBeenCalledTimes(2)

    unmount()
    visibilitySpy.mockRestore()
  })

  it('runs a fresh reconciliation after becoming visible during an in-flight request', async () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = 'visible'
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState)
    const firstSnapshot = deferred<unknown>()
    const listTasks = vi.fn()
      .mockImplementationOnce(async () => firstSnapshot.promise)
      .mockResolvedValueOnce({ tasks: [] })
    const { unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet: listTasks as BridgeCaller,
      log: vi.fn(),
    }))

    await act(flushPromises)
    expect(listTasks).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(listTasks).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstSnapshot.resolve({ tasks: [] })
      await flushPromises()
    })
    expect(listTasks).toHaveBeenCalledTimes(2)

    unmount()
    visibilitySpy.mockRestore()
  })

  it('uses the active interval when a task changes during an empty snapshot request', async () => {
    vi.useFakeTimers()
    const firstSnapshot = deferred<unknown>()
    const listTasks = vi.fn()
      .mockImplementationOnce(async () => firstSnapshot.promise)
      .mockResolvedValueOnce({ tasks: [] })
    const { result, unmount } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet: listTasks as BridgeCaller,
      log: vi.fn(),
    }))

    act(() => {
      window.dispatchEvent(new CustomEvent('unreal-editor-webui', {
        detail: {
          type: 'task.status',
          taskId: 'task-during-snapshot',
          status: 'running',
          progress: 10,
        },
      }))
    })
    await act(async () => {
      firstSnapshot.resolve({ tasks: [] })
      await flushPromises()
    })
    expect(result.current.taskRecords['task-during-snapshot']).toBeDefined()

    await act(async () => {
      vi.advanceTimersByTime(15_000)
      await flushPromises()
    })
    expect(listTasks).toHaveBeenCalledTimes(2)

    unmount()
  })

  it('removes records no longer present in an authoritative snapshot', async () => {
    vi.useFakeTimers()
    const callBridgeQuiet = vi.fn()
      .mockResolvedValueOnce({
        tasks: [{ taskId: 'task-pruned', status: 'completed', progress: 100 }],
      })
      .mockResolvedValueOnce({ tasks: [] }) as BridgeCaller
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await act(flushPromises)
    expect(result.current.taskRecords['task-pruned']).toBeDefined()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await flushPromises()
    })
    expect(result.current.taskRecords['task-pruned']).toBeUndefined()
  })

  it('rejects an invalid snapshot without clearing existing tasks', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const callBridgeQuiet = vi.fn()
      .mockResolvedValueOnce({
        tasks: [{ taskId: 'task-valid', status: 'completed', progress: 100 }],
      })
      .mockResolvedValueOnce({ tasks: [{ taskId: 'task-invalid', status: 'mystery' }] }) as BridgeCaller
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log,
    }))

    await act(flushPromises)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await flushPromises()
    })

    expect(result.current.taskRecords['task-valid'].status).toBe('completed')
    expect(result.current.taskRecords['task-invalid']).toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Unable to reconcile tasks: Invalid bridge response from listtasks'),
    )
  })

  it('loads full task details only after an explicit request and only once', async () => {
    const callBridgeQuiet = bridgeCaller({
      listtasks: {
        tasks: [{ taskId: 'task-detail', command: 'asset.scan', status: 'completed', progress: 100 }],
      },
      gettask: {
        taskId: 'task-detail',
        command: 'asset.scan',
        payload: { path: '/Game' },
        status: 'completed',
        progress: 100,
        logs: ['complete'],
        responseJson: JSON.stringify({ id: null, ok: true, result: { count: 1 } }),
      },
    })
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge: bridgeCaller({}),
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await waitFor(() => expect(result.current.taskRecords['task-detail']).toBeDefined())
    expect(callBridgeQuiet).not.toHaveBeenCalledWith('gettask', 'task-detail')

    await act(async () => {
      expect(await result.current.loadTaskDetails('task-detail')).toBe(true)
    })
    expect(result.current.taskRecords['task-detail']).toMatchObject({
      logs: ['complete'],
      payload: { path: '/Game' },
    })

    await act(async () => {
      expect(await result.current.loadTaskDetails('task-detail')).toBe(true)
    })
    expect(callBridgeQuiet).toHaveBeenCalledWith('gettask', 'task-detail')
    expect(callBridgeQuiet).toHaveBeenCalledTimes(2)
  })
})
