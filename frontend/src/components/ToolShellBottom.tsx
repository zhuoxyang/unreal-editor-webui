import type { BridgeCaller } from '../bridge'
import type { CommandMetadata } from '../types/command'
import type { TaskRecord } from '../types/task'
import { MessageLogPanel } from './MessageLogPanel'
import { SettingsPanel } from './SettingsPanel'
import { TaskMonitorPanel } from './TaskMonitorPanel'

type ToolShellBottomProps = {
  bridgeReady: boolean
  callBridge: BridgeCaller
  callBridgeQuiet: BridgeCaller
  commands: CommandMetadata[]
  eventLines: string[]
  log: (message: string) => void
  logLines: string[]
  taskList: TaskRecord[]
  onCancelTask: (taskId: string) => void
  onRemoveTask: (taskId: string) => void
}

export function ToolShellBottom({
  bridgeReady,
  callBridge,
  callBridgeQuiet,
  commands,
  eventLines,
  log,
  logLines,
  onCancelTask,
  onRemoveTask,
  taskList,
}: ToolShellBottomProps) {
  return (
    <section className="tool-shell-bottom">
      <TaskMonitorPanel
        bridgeReady={bridgeReady}
        commands={commands}
        onCancel={onCancelTask}
        onRemove={onRemoveTask}
        tasks={taskList}
      />

      <MessageLogPanel
        emptyMessage="Task status events will appear here."
        lines={eventLines}
        title="Message Log"
      />

      <SettingsPanel
        bridgeReady={bridgeReady}
        callBridge={callBridge}
        callBridgeQuiet={callBridgeQuiet}
        log={log}
      />

      <MessageLogPanel
        emptyMessage="No bridge log entries."
        lines={logLines}
        title="Bridge Log"
      />
    </section>
  )
}

