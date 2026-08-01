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
  onLoadTaskDetails: (taskId: string) => Promise<boolean>
  onClearLocalData: () => void
  persistenceEnabled: boolean
  projectContextReady: boolean
  projectName: string
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
  onLoadTaskDetails,
  onClearLocalData,
  persistenceEnabled,
  projectContextReady,
  projectName,
  taskList,
}: ToolShellBottomProps) {
  return (
    <section className="tool-shell-bottom">
      <TaskMonitorPanel
        bridgeReady={bridgeReady}
        commands={commands}
        onCancel={onCancelTask}
        onLoadDetails={onLoadTaskDetails}
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
        onClearLocalData={onClearLocalData}
        persistenceEnabled={persistenceEnabled}
        projectContextReady={projectContextReady}
        projectName={projectName}
      />

      <MessageLogPanel
        emptyMessage="No bridge log entries."
        lines={logLines}
        title="Bridge Log"
      />
    </section>
  )
}

