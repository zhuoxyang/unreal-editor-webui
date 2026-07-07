import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BridgeCaller } from '../bridge'
import { isTerminalTaskStatus, parseTaskStatus } from '../task-model'
import type { TaskResult } from '../types/bridge'
import type { TaskRecord, WebUIEvent } from '../types/task'

type UseTasksOptions = {
  bridgeReady: boolean
  callBridge: BridgeCaller
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

export function useTasks({ bridgeReady, callBridge, callBridgeQuiet, log }: UseTasksOptions) {
  const [taskRecords, setTaskRecords] = useState<Record<string, TaskRecord>>({})
  const [eventLines, setEventLines] = useState<string[]>([])

  const taskList = useMemo(() => {
    return Object.values(taskRecords).sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }, [taskRecords])

  const activeTaskIds = useMemo(() => {
    return taskList.filter((task) => !isTerminalTaskStatus(task.status)).map((task) => task.taskId)
  }, [taskList])

  const activeTaskKey = activeTaskIds.join('|')

  const mergeTaskResult = useCallback((task: TaskResult, fallback?: Partial<TaskRecord>) => {
    setTaskRecords((records) => {
      const existing = records[task.taskId]
      const startedAt = existing?.startedAt || fallback?.startedAt || task.createdAt || new Date().toISOString()
      const command = task.command || existing?.command || fallback?.command || 'unknown'
      const payload = task.payload || existing?.payload || fallback?.payload || {}
      const replacesLastError = fallback && Object.prototype.hasOwnProperty.call(fallback, 'lastError')

      return {
        ...records,
        [task.taskId]: {
          ...existing,
          ...fallback,
          ...task,
          command,
          payload,
          startedAt,
          progress: task.progress ?? existing?.progress ?? 0,
          cancellable: task.cancellable ?? existing?.cancellable ?? false,
          cancellationMode: task.cancellationMode ?? existing?.cancellationMode,
          executionThread: task.executionThread ?? existing?.executionThread,
          timeoutPolicy: task.timeoutPolicy ?? existing?.timeoutPolicy,
          message: task.message ?? existing?.message,
          logs: task.logs ?? existing?.logs ?? [],
          updatedAt: task.updatedAt || existing?.updatedAt || new Date().toISOString(),
          lastError: replacesLastError ? fallback.lastError : existing?.lastError,
        },
      }
    })
  }, [])

  const mergeTaskEvent = useCallback((detail: WebUIEvent) => {
    if (!detail.taskId) {
      return
    }

    const taskId = detail.taskId
    const status = parseTaskStatus(detail.status)
    if (!status) {
      return
    }

    setTaskRecords((records) => {
      const existing = records[taskId]
      const logs = detail.log ? [...(existing?.logs || []), detail.log].slice(-80) : existing?.logs || []

      return {
        ...records,
        [taskId]: {
          taskId,
          command: existing?.command || 'unknown',
          payload: existing?.payload || {},
          startedAt: existing?.startedAt || detail.updatedAt || new Date().toISOString(),
          status,
          progress: detail.progress ?? existing?.progress ?? 0,
          cancellable: detail.cancellable ?? existing?.cancellable ?? false,
          cancellationMode: detail.cancellationMode ?? existing?.cancellationMode,
          executionThread: detail.executionThread ?? existing?.executionThread,
          timeoutPolicy: detail.timeoutPolicy ?? existing?.timeoutPolicy,
          message: detail.message ?? existing?.message,
          logs,
          createdAt: existing?.createdAt,
          updatedAt: detail.updatedAt || new Date().toISOString(),
          responseJson: detail.responseJson ?? existing?.responseJson,
          lastError: existing?.lastError,
        },
      }
    })
  }, [])

  useEffect(() => {
    function handleWebUIEvent(event: Event) {
      const customEvent = event as CustomEvent<WebUIEvent>
      const detail = customEvent.detail
      if (!detail) {
        return
      }

      const time = new Date().toLocaleTimeString()
      const taskSummary = detail.taskId ? ` ${detail.taskId}` : ''
      const statusSummary = detail.status ? ` ${detail.status}` : ''
      const progressSummary = typeof detail.progress === 'number' ? ` ${detail.progress}%` : ''
      const logSummary = detail.log ? ` ${detail.log}` : ''
      setEventLines((lines) => [
        `[${time}] ${detail.type}${taskSummary}${statusSummary}${progressSummary}${logSummary}`,
        ...lines,
      ].slice(0, 80))
      mergeTaskEvent(detail)
    }

    window.addEventListener('unreal-editor-webui', handleWebUIEvent)
    return () => window.removeEventListener('unreal-editor-webui', handleWebUIEvent)
  }, [mergeTaskEvent])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    let stopped = false
    void callBridgeQuiet<{ tasks: TaskResult[] }>('listtasks')
      .then((result) => {
        if (!stopped) {
          result.tasks.forEach((task) => mergeTaskResult(task))
        }
      })
      .catch((error) => {
        if (!stopped) {
          log(`Unable to restore tasks: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

    return () => {
      stopped = true
    }
  }, [bridgeReady, callBridgeQuiet, log, mergeTaskResult])

  const recordTaskPollingError = useCallback((taskId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setTaskRecords((records) => {
      const existing = records[taskId]
      if (!existing) {
        return records
      }

      return {
        ...records,
        [taskId]: {
          ...existing,
          lastError: message,
        },
      }
    })
  }, [])

  useEffect(() => {
    if (!bridgeReady || !activeTaskKey) {
      return
    }

    let stopped = false
    const taskIds = activeTaskKey.split('|')
    let timeoutId: number | undefined
    let consecutiveFailures = 0

    async function refreshTasks() {
      let hadFailure = false
      await Promise.all(taskIds.map(async (taskId) => {
        try {
          const task = await callBridgeQuiet<TaskResult>('gettask', taskId)
          if (!stopped) {
            mergeTaskResult(task, { lastError: undefined })
          }
        } catch (error) {
          hadFailure = true
          if (!stopped) {
            recordTaskPollingError(taskId, error)
          }
        }
      }))

      if (stopped) {
        return
      }

      consecutiveFailures = hadFailure ? Math.min(consecutiveFailures + 1, 4) : 0
      const delay = Math.min(1000 * 2 ** consecutiveFailures, 10000)
      timeoutId = window.setTimeout(() => {
        void refreshTasks()
      }, delay)
    }

    void refreshTasks()

    return () => {
      stopped = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [activeTaskKey, bridgeReady, callBridgeQuiet, mergeTaskResult, recordTaskPollingError])

  async function cancelTask(taskId: string) {
    try {
      const task = await callBridge<TaskResult>('canceltask', taskId)
      mergeTaskResult(task)
    } catch (error) {
      try {
        const latest = await callBridgeQuiet<TaskResult>('gettask', taskId)
        mergeTaskResult(latest, {
          lastError: error instanceof Error ? error.message : String(error),
        })
        return
      } catch {
        // Keep the original cancel error if the follow-up refresh also fails.
      }

      mergeTaskResult(
        {
          taskId,
          status: taskRecords[taskId]?.status || 'failed',
        },
        {
          lastError: error instanceof Error ? error.message : String(error),
        },
      )
    }
  }

  async function removeTask(taskId: string) {
    try {
      await callBridge<{ removed: boolean }>('removetask', taskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(message)
      recordTaskPollingError(taskId, error)
      return
    }

    setTaskRecords((records) => {
      const next = { ...records }
      delete next[taskId]
      return next
    })
  }

  return {
    cancelTask,
    eventLines,
    mergeTaskResult,
    removeTask,
    taskList,
    taskRecords,
  }
}

