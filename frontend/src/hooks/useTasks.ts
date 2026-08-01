import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBridgeError, type BridgeCaller } from '../bridge'
import { decodeRemoveTaskResult, decodeTaskListResult, decodeTaskResult } from '../bridge-decoders'
import { isTerminalTaskStatus, parseTaskStatus } from '../task-model'
import type { TaskResult } from '../types/bridge'
import type { TaskRecord, WebUIEvent } from '../types/task'

type UseTasksOptions = {
  bridgeReady: boolean
  callBridge: BridgeCaller
  callBridgeQuiet: BridgeCaller
  log: (message: string) => void
}

const ACTIVE_RECONCILIATION_INTERVAL_MS = 15_000
const IDLE_RECONCILIATION_INTERVAL_MS = 60_000
const MAX_RECONCILIATION_BACKOFF_MS = 60_000

function isPageHidden() {
  return document.visibilityState === 'hidden'
}

function canAdvanceTaskStatus(current: TaskRecord['status'], incoming: TaskResult['status']) {
  if (isTerminalTaskStatus(current)) {
    return incoming === current
  }
  if (current === 'running' && incoming === 'queued') {
    return false
  }
  return true
}

function isOlderLifecycleUpdate(existing: TaskRecord, task: TaskResult) {
  const existingTimestamp = existing.updatedAt ? Date.parse(existing.updatedAt) : Number.NaN
  const incomingTimestamp = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN
  if (
    Number.isFinite(existingTimestamp) &&
    Number.isFinite(incomingTimestamp) &&
    incomingTimestamp < existingTimestamp
  ) {
    return true
  }

  return (
    existing.status === task.status &&
    task.progress !== undefined &&
    existing.progress !== undefined &&
    task.progress < existing.progress
  )
}

function mergeTaskRecord(
  existing: TaskRecord | undefined,
  task: TaskResult,
  fallback?: Partial<TaskRecord>,
  source: 'local' | 'snapshot' = 'local',
): TaskRecord {
  const startedAt = existing?.startedAt || fallback?.startedAt || task.createdAt || new Date().toISOString()
  const command = task.command || existing?.command || fallback?.command || 'unknown'
  const payload = task.payload || existing?.payload || fallback?.payload || {}
  const replacesLastError = Boolean(fallback && Object.prototype.hasOwnProperty.call(fallback, 'lastError'))

  const merged: TaskRecord = {
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
    responseJson: task.responseJson ?? existing?.responseJson,
    lastError: replacesLastError ? fallback?.lastError : existing?.lastError,
  }

  if (
    existing &&
    (
      !canAdvanceTaskStatus(existing.status, task.status) ||
      (source === 'local' && isOlderLifecycleUpdate(existing, task))
    )
  ) {
    return {
      ...merged,
      status: existing.status,
      progress: existing.progress,
      cancellable: existing.cancellable,
      message: existing.message,
      logs: existing.logs,
      updatedAt: existing.updatedAt,
      responseJson: existing.responseJson,
    }
  }
  return merged
}

function mergeStaticTaskFields(existing: TaskRecord, task: TaskResult): TaskRecord {
  const fillsMissingCreatedAt = !existing.createdAt && Boolean(task.createdAt)
  return {
    ...existing,
    command: existing.command === 'unknown' && task.command ? task.command : existing.command,
    payload: Object.keys(existing.payload).length === 0 && task.payload ? task.payload : existing.payload,
    createdAt: existing.createdAt || task.createdAt,
    startedAt: fillsMissingCreatedAt && task.createdAt ? task.createdAt : existing.startedAt,
    cancellationMode: existing.cancellationMode || task.cancellationMode,
    executionThread: existing.executionThread || task.executionThread,
    timeoutPolicy: existing.timeoutPolicy || task.timeoutPolicy,
  }
}

export function useTasks({ bridgeReady, callBridge, callBridgeQuiet, log }: UseTasksOptions) {
  const [taskRecords, setTaskRecords] = useState<Record<string, TaskRecord>>({})
  const [eventLines, setEventLines] = useState<string[]>([])
  const revisionRef = useRef(0)
  const taskRevisionsRef = useRef(new Map<string, number>())
  const removedTaskIdsRef = useRef(new Set<string>())
  const detailedTaskIdsRef = useRef(new Set<string>())
  const detailRequestsRef = useRef(new Set<string>())
  const logRef = useRef(log)

  useEffect(() => {
    logRef.current = log
  }, [log])

  const taskList = useMemo(() => {
    return Object.values(taskRecords).sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }, [taskRecords])

  const markTaskChanged = useCallback((taskId: string) => {
    revisionRef.current += 1
    taskRevisionsRef.current.set(taskId, revisionRef.current)
  }, [])

  const mergeTaskResult = useCallback((task: TaskResult, fallback?: Partial<TaskRecord>) => {
    if (!task.taskId || !parseTaskStatus(task.status) || removedTaskIdsRef.current.has(task.taskId)) {
      return
    }

    markTaskChanged(task.taskId)
    setTaskRecords((records) => ({
      ...records,
      [task.taskId]: mergeTaskRecord(records[task.taskId], task, fallback),
    }))
  }, [markTaskChanged])

  const mergeTaskEvent = useCallback((detail: WebUIEvent) => {
    if (!detail.taskId || removedTaskIdsRef.current.has(detail.taskId)) {
      return
    }

    const taskId = detail.taskId
    const status = parseTaskStatus(detail.status)
    if (!status) {
      return
    }

    markTaskChanged(taskId)
    setTaskRecords((records) => {
      const existing = records[taskId]
      const logs = detail.log ? [...(existing?.logs || []), detail.log].slice(-80) : existing?.logs || []
      const incoming: TaskResult = {
        taskId,
        status,
        progress: detail.progress,
        cancellable: detail.cancellable,
        cancellationMode: detail.cancellationMode,
        executionThread: detail.executionThread,
        timeoutPolicy: detail.timeoutPolicy,
        message: detail.message,
        logs,
        updatedAt: detail.updatedAt,
        responseJson: detail.responseJson,
      }
      return {
        ...records,
        [taskId]: mergeTaskRecord(existing, incoming),
      }
    })
  }, [markTaskChanged])

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

  const reconcileTaskSnapshot = useCallback((tasks: TaskResult[], snapshotRevision: number) => {
    const snapshotTaskIds = new Set(tasks.map((task) => task.taskId))
    setTaskRecords((records) => {
      const next = { ...records }

      for (const task of tasks) {
        if (removedTaskIdsRef.current.has(task.taskId)) {
          continue
        }

        const existing = next[task.taskId]
        const changedAfterRequest = (taskRevisionsRef.current.get(task.taskId) || 0) > snapshotRevision
        next[task.taskId] = existing && changedAfterRequest
          ? mergeStaticTaskFields(existing, task)
          : mergeTaskRecord(existing, task, { lastError: undefined }, 'snapshot')
      }

      for (const taskId of Object.keys(next)) {
        const changedAfterRequest = (taskRevisionsRef.current.get(taskId) || 0) > snapshotRevision
        if (
          removedTaskIdsRef.current.has(taskId) ||
          (!snapshotTaskIds.has(taskId) && !changedAfterRequest)
        ) {
          delete next[taskId]
        }
      }

      for (const taskId of removedTaskIdsRef.current) {
        const removedBeforeRequest = (taskRevisionsRef.current.get(taskId) || 0) <= snapshotRevision
        if (removedBeforeRequest && !snapshotTaskIds.has(taskId)) {
          removedTaskIdsRef.current.delete(taskId)
          taskRevisionsRef.current.delete(taskId)
        }
      }

      return next
    })
  }, [])

  useEffect(() => {
    if (!bridgeReady) {
      return
    }

    let stopped = false
    let inFlight = false
    let pendingImmediate = false
    let timeoutId: number | undefined
    let consecutiveFailures = 0

    function clearTimer() {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    function schedule(delay: number) {
      clearTimer()
      if (stopped || isPageHidden()) {
        return
      }
      timeoutId = window.setTimeout(() => {
        void reconcileTasks()
      }, delay)
    }

    async function reconcileTasks() {
      if (stopped || isPageHidden()) {
        return
      }
      if (inFlight) {
        pendingImmediate = true
        return
      }

      inFlight = true
      const snapshotRevision = revisionRef.current
      try {
        const result = await callBridgeQuiet<unknown>('listtasks')
        if (stopped) {
          return
        }

        const tasks = decodeTaskListResult(result)
        reconcileTaskSnapshot(tasks, snapshotRevision)
        consecutiveFailures = 0
        const hasActiveTasks =
          revisionRef.current > snapshotRevision ||
          tasks.some((task) => !isTerminalTaskStatus(task.status))
        schedule(hasActiveTasks ? ACTIVE_RECONCILIATION_INTERVAL_MS : IDLE_RECONCILIATION_INTERVAL_MS)
      } catch (error) {
        if (stopped) {
          return
        }

        consecutiveFailures = Math.min(consecutiveFailures + 1, 6)
        logRef.current(`Unable to reconcile tasks: ${formatBridgeError(error)}`)
        schedule(Math.min(1000 * 2 ** consecutiveFailures, MAX_RECONCILIATION_BACKOFF_MS))
      } finally {
        inFlight = false
        if (pendingImmediate && !stopped && !isPageHidden()) {
          pendingImmediate = false
          clearTimer()
          void reconcileTasks()
        }
      }
    }

    function handleVisibilityChange() {
      clearTimer()
      if (isPageHidden()) {
        pendingImmediate = false
      } else {
        void reconcileTasks()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void reconcileTasks()

    return () => {
      stopped = true
      clearTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [bridgeReady, callBridgeQuiet, reconcileTaskSnapshot])

  const recordTaskError = useCallback((taskId: string, error: unknown) => {
    const message = formatBridgeError(error)
    markTaskChanged(taskId)
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
  }, [markTaskChanged])

  const loadTaskDetails = useCallback(async (taskId: string) => {
    if (detailedTaskIdsRef.current.has(taskId)) {
      return true
    }
    if (detailRequestsRef.current.has(taskId)) {
      return false
    }

    detailRequestsRef.current.add(taskId)
    try {
      const task = decodeTaskResult('gettask', await callBridgeQuiet<unknown>('gettask', taskId), taskId)
      mergeTaskResult(task, { lastError: undefined })
      if (isTerminalTaskStatus(task.status)) {
        detailedTaskIdsRef.current.add(taskId)
        return true
      }
      return false
    } catch (error) {
      recordTaskError(taskId, error)
      logRef.current(`Unable to load task details: ${formatBridgeError(error)}`)
      return false
    } finally {
      detailRequestsRef.current.delete(taskId)
    }
  }, [callBridgeQuiet, mergeTaskResult, recordTaskError])

  async function cancelTask(taskId: string) {
    try {
      const task = decodeTaskResult('canceltask', await callBridge<unknown>('canceltask', taskId), taskId)
      mergeTaskResult(task)
    } catch (error) {
      try {
        const latest = decodeTaskResult('gettask', await callBridgeQuiet<unknown>('gettask', taskId), taskId)
        mergeTaskResult(latest, {
          lastError: formatBridgeError(error),
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
          lastError: formatBridgeError(error),
        },
      )
    }
  }

  async function removeTask(taskId: string) {
    try {
      const result = decodeRemoveTaskResult(await callBridge<unknown>('removetask', taskId), taskId)
      if (result.removed !== true) {
        throw new Error(`Bridge did not confirm removal for task: ${taskId}`)
      }
    } catch (error) {
      log(formatBridgeError(error))
      recordTaskError(taskId, error)
      return
    }

    markTaskChanged(taskId)
    removedTaskIdsRef.current.add(taskId)
    detailedTaskIdsRef.current.delete(taskId)
    detailRequestsRef.current.delete(taskId)
    setTaskRecords((records) => {
      const next = { ...records }
      delete next[taskId]
      return next
    })
  }

  return {
    cancelTask,
    eventLines,
    loadTaskDetails,
    mergeTaskResult,
    removeTask,
    taskList,
    taskRecords,
  }
}
