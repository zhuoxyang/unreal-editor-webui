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
}

export function TaskCard({ bridgeReady, resultType, task, onCancel, onRemove }: TaskCardProps) {
  const canCancel = task.cancellable === true
  const canRemove = isTerminalTaskStatus(task.status)
  let parsedTaskResponse: BridgeResponse<unknown> | null = null
  if (task.responseJson) {
    try {
      parsedTaskResponse = JSON.parse(task.responseJson) as BridgeResponse<unknown>
    } catch {
      parsedTaskResponse = null
    }
  }

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
      {task.lastError ? <p className="task-error">{task.lastError}</p> : null}
      {task.message ? <p className="muted">{task.message}</p> : null}
      {task.logs && task.logs.length > 0 ? (
        <pre>{task.logs.slice(-8).join('\n')}</pre>
      ) : (
        <p className="muted">No task logs yet.</p>
      )}
      {task.responseJson ? (
        <details>
          <summary>Response</summary>
          {parsedTaskResponse?.ok ? (
            <ResultRenderer result={parsedTaskResponse.result} resultType={resultType} />
          ) : (
            <pre>{task.responseJson}</pre>
          )}
        </details>
      ) : null}
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

