import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTasks } from './useTasks'
import type { BridgeCaller } from '../bridge'

function bridgeCaller(resultByMethod: Record<string, unknown>): BridgeCaller {
  return vi.fn(async (methodName: string) => {
    const result = resultByMethod[methodName]
    if (result instanceof Error) {
      throw result
    }
    return result
  }) as BridgeCaller
}

describe('useTasks', () => {
  it('restores tasks and merges task events without marking transient failures terminal', async () => {
    const callBridgeQuiet = bridgeCaller({
      listtasks: {
        tasks: [{ taskId: 'task-1', command: 'asset.scan', payload: {}, status: 'running', progress: 10 }],
      },
      gettask: new Error('temporary bridge failure'),
    })
    const callBridge = bridgeCaller({})
    const { result } = renderHook(() => useTasks({
      bridgeReady: true,
      callBridge,
      callBridgeQuiet,
      log: vi.fn(),
    }))

    await waitFor(() => expect(result.current.taskList[0]?.taskId).toBe('task-1'))
    await waitFor(() => expect(result.current.taskRecords['task-1']?.lastError).toBe('temporary bridge failure'))

    expect(result.current.taskRecords['task-1'].status).toBe('running')

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

    await waitFor(() => expect(result.current.taskRecords['task-1'].status).toBe('completed'))
    expect(result.current.eventLines[0]).toContain('task.status task-1 completed 100% done')
  })
})
