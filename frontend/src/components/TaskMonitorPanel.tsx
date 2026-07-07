import type { CommandMetadata } from '../types/command'
import type { TaskRecord } from '../types/task'
import { TaskCard } from './TaskCard'

type TaskMonitorPanelProps = {
  bridgeReady: boolean
  commands: CommandMetadata[]
  tasks: TaskRecord[]
  onCancel: (taskId: string) => void
  onRemove: (taskId: string) => void
}

export function TaskMonitorPanel({ bridgeReady, commands, onCancel, onRemove, tasks }: TaskMonitorPanelProps) {
  return (
    <div className="panel task-panel">
      <h2>Task Monitor</h2>
      {tasks.length > 0 ? (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskCard
              bridgeReady={bridgeReady}
              key={task.taskId}
              onCancel={onCancel}
              onRemove={onRemove}
              resultType={commands.find((command) => command.name === task.command)?.resultType}
              task={task}
            />
          ))}
        </div>
      ) : (
        <p className="muted">Started tasks will appear here.</p>
      )}
    </div>
  )
}

