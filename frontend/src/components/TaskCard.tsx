import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { parseBridgeResponse } from '../bridge'
import { formatRecentTime } from '../recent-executions'
import { isTerminalTaskStatus } from '../task-model'
import type { BridgeResponse } from '../types/bridge'
import type { TaskRecord } from '../types/task'
import { ResultRenderer } from './ResultRenderer'

type TaskCardProps = {
  bridgeReady: boolean
  resultType?: string
  task: TaskRecord
  onCancel: (taskId: string) => void
  onRemove: (taskId: string) => void
  onLoadDetails: (taskId: string) => Promise<boolean>
}

export function TaskCard({ bridgeReady, resultType, task, onCancel, onLoadDetails, onRemove }: TaskCardProps) {
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'loaded'>('idle')
  const detailStateRef = useRef(detailState)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const terminalAttemptRef = useRef<string | null>(null)
  const canCancel = task.cancellable === true
  const canRemove = isTerminalTaskStatus(task.status)
  let parsedTaskResponse: BridgeResponse<unknown> | null = null

  if (task.responseJson) {
    try {
      parsedTaskResponse = parseBridgeResponse<unknown>('gettask', task.responseJson)
    } catch {
      parsedTaskResponse = null
    }
  }

  async function handleDetailsToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const isOpen = event.currentTarget.open
    setDetailsOpen(isOpen)
    if (!isOpen) {
      if (detailStateRef.current === 'idle') {
        terminalAttemptRef.current = null
      }
      return
    }
    if (detailStateRef.current !== 'idle') {
      return
    }
    detailStateRef.current = 'loading'
    setDetailState('loading')
    const loaded = await onLoadDetails(task.taskId)
    const nextState = loaded ? 'loaded' : 'idle'
    detailStateRef.current = nextState
    setDetailState(nextState)
  }

  useEffect(() => {
    if (!detailsOpen || detailStateRef.current !== 'idle' || !isTerminalTaskStatus(task.status)) {
      return
    }

    const attemptKey = `${task.status}:${task.updatedAt || ''}`
    if (terminalAttemptRef.current === attemptKey) {
      return
    }
    terminalAttemptRef.current = attemptKey
    let stopped = false
    detailStateRef.current = 'loading'
    setDetailState('loading')
    void onLoadDetails(task.taskId).then((loaded) => {
      if (!stopped) {
        const nextState = loaded ? 'loaded' : 'idle'
        detailStateRef.current = nextState
        setDetailState(nextState)
      }
    })
    return () => {
      stopped = true
    }
  }, [detailsOpen, onLoadDetails, task.status, task.taskId, task.updatedAt])

  return (
    <article className="task-card">
      <div className="task-card-header">
        <div>
          <strong>{task.command}</strong>
          <small>{task.taskId}</small>
        </div>
        <span className={`badge ${task.status}`}>{task.status}</span>
      </div>
      <div className="task-progress">
        <span style={{ width: `${task.progress ?? 0}%` }} />
      </div>
      <div className="task-meta">
        <span>{task.progress ?? 0}%</span>
        <span>{task.updatedAt ? formatRecentTime(task.updatedAt) : formatRecentTime(task.startedAt)}</span>
      </div>
      <div className="task-lifecycle">
        <span>{task.executionThread || 'unknown thread'}</span>
        <span>cancel: {task.cancellationMode || (task.cancellable ? 'available' : 'not available')}</span>
        <span>timeout: {task.timeoutPolicy || 'unknown'}</span>
      </div>
      {task.lastError ? <p className="task-error" role="alert">{task.lastError}</p> : null}
      {task.message ? <p className="muted">{task.message}</p> : null}
      <details onToggle={(event) => void handleDetailsToggle(event)}>
        <summary>{detailState === 'loading' ? 'Loading details…' : 'Details'}</summary>
        {task.logs && task.logs.length > 0 ? (
          <pre>{task.logs.slice(-8).join('\n')}</pre>
        ) : (
          <p className="muted">No task logs available.</p>
        )}
        {task.responseJson ? (
          <details>
            <summary>Response</summary>
            {parsedTaskResponse?.ok ? (
              <ResultRenderer result={parsedTaskResponse.result} resultType={resultType} />
            ) : (
              <pre>{task.responseJson.slice(0, 100_000)}{task.responseJson.length > 100_000 ? '\n…' : ''}</pre>
            )}
          </details>
        ) : (
          <p className="muted">No task response available.</p>
        )}
      </details>
      <div className="task-actions">
        <button type="button" onClick={() => onCancel(task.taskId)} disabled={!bridgeReady || !canCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => onRemove(task.taskId)} disabled={!bridgeReady || !canRemove}>
          Remove
        </button>
      </div>
    </article>
  )
}
