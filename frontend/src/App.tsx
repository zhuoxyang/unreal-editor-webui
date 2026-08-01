import { useCallback, useState } from 'react'
import './App.css'
import { CommandInspectorPanel } from './components/CommandInspectorPanel'
import { ResultRenderer } from './components/ResultRenderer'
import { ToolShellBottom } from './components/ToolShellBottom'
import { ToolShellHeader } from './components/ToolShellHeader'
import { ToolRackPanel } from './components/ToolRackPanel'
import { WorkspacePanel } from './components/WorkspacePanel'
import { useEditorBridge } from './bridge'
import { useCommandPayloads } from './hooks/useCommandPayloads'
import { useCommandRunner } from './hooks/useCommandRunner'
import { useCommands } from './hooks/useCommands'
import { useRecentExecutions } from './hooks/useRecentExecutions'
import { useProjectContext } from './hooks/useProjectContext'
import { useTasks } from './hooks/useTasks'
import { useToolPreferences } from './hooks/useToolPreferences'
import { useToolWorkspace } from './hooks/useToolWorkspace'
import { hasCommandResult } from './schema-form'
import { TOOL_CATEGORIES, TOOL_PROJECTS } from './tool-manifest'
import { commandHasDryRun } from './types/command'

function App() {
  const [commandSearch, setCommandSearch] = useState('')
  const [selectedCommandName, setSelectedCommandName] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>(['Open this app inside the Unreal Editor WebUI tab to enable the bridge.'])

  const log = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString()
    setLogLines((lines) => [`[${time}] ${message}`, ...lines].slice(0, 80))
  }, [])

  const { bridgeReady, callBridge, callBridgeQuiet } = useEditorBridge(log)
  const { projectContext, projectContextReady } = useProjectContext({ bridgeReady, callBridgeQuiet, log })
  const { commands, commandsError, commandsStatus, retryCommands } = useCommands({ bridgeReady, callBridgeQuiet, log })
  const { clearRecentExecutions, recentExecutions, recordRecentExecution } = useRecentExecutions(
    projectContext.storageNamespace,
  )
  const {
    buildPayload,
    clearPayloadDraft,
    getFieldValue,
    loadPayloadDraft,
    loadSchemaDefaults,
    updateField,
  } = useCommandPayloads()
  const {
    closeWorkspaceCommand,
    favoriteCommands,
    openWorkspaceCommand,
    resetToolPreferences,
    toggleFavoriteCommand,
    toolPreferences,
    updateToolCategory,
    updateToolProject,
    updateToolStage,
    workspaceTabs,
  } = useToolPreferences(projectContext.storageNamespace)
  const {
    cancelTask,
    eventLines,
    loadTaskDetails,
    mergeTaskResult,
    removeTask,
    taskList,
  } = useTasks({ bridgeReady, callBridge, callBridgeQuiet, log })
  const {
    commandInvocations,
    commandResults,
    runCommandFromMetadata,
    startTaskFromMetadata,
  } = useCommandRunner({
    buildPayload,
    callBridge,
    log,
    mergeTaskResult,
    recordRecentExecution,
  })

  const {
    availableStages,
    favoriteCommandSet,
    filteredCommands,
    selectedCommand,
    visibleFavoriteCommands,
    visibleRecentCommands,
    workspaceCommandTabs,
  } = useToolWorkspace({
    commands,
    commandSearch,
    favoriteCommands,
    recentExecutions,
    selectedCommandName,
    toolPreferences,
    workspaceTabs,
  })

  function openCommandWorkspace(commandName: string) {
    setSelectedCommandName(commandName)
    openWorkspaceCommand(commandName)
  }

  function closeCommandWorkspace(commandName: string) {
    closeWorkspaceCommand(commandName, selectedCommandName, setSelectedCommandName)
  }

  function renderCommandResult(commandName: string) {
    const result = commandResults[commandName]
    const invocation = commandInvocations[commandName]
    if (!hasCommandResult(commandResults, commandName)) {
      return null
    }

    const command = commands.find((item) => item.name === commandName)
    return (
      <>
        {invocation?.stale ? (
          <p className="stale-result-message" role="status">
            {invocation.status === 'pending'
              ? 'A new invocation is in progress; showing the previous successful result.'
              : 'Showing the previous successful result. The latest invocation did not replace it.'}
          </p>
        ) : null}
        <ResultRenderer commandName={commandName} result={result} resultType={command?.resultType} />
      </>
    )
  }

  return (
    <main className="app-shell tool-shell">
      <ToolShellHeader bridgeReady={bridgeReady} />

      <section className="tool-shell-layout">
        <ToolRackPanel
          categories={TOOL_CATEGORIES}
          commandsError={commandsError}
          commandsStatus={commandsStatus}
          categoryId={toolPreferences.categoryId}
          commands={filteredCommands}
          favoriteCommands={visibleFavoriteCommands}
          onCategoryChange={updateToolCategory}
          onOpenCommand={openCommandWorkspace}
          onProjectChange={updateToolProject}
          onRetryCommands={() => void retryCommands()}
          onSearchChange={setCommandSearch}
          onStageChange={updateToolStage}
          projectId={toolPreferences.projectId}
          projects={TOOL_PROJECTS}
          recentCommands={visibleRecentCommands}
          search={commandSearch}
          selectedCommandName={selectedCommand?.name || null}
          shownCount={filteredCommands.length}
          stageId={toolPreferences.stageId}
          stages={availableStages}
        />

        <WorkspacePanel
          activeTabName={selectedCommand?.name || null}
          badges={
            selectedCommand ? (
              <>
                <span className={`badge ${selectedCommand.permission}`}>{selectedCommand.permission}</span>
                {commandHasDryRun(selectedCommand) ? <span className="badge dry-run">dry-run</span> : null}
                {selectedCommand.execution?.thread ? (
                  <span className="badge execution">{selectedCommand.execution.thread}</span>
                ) : null}
              </>
            ) : null
          }
          category={selectedCommand?.category || selectedCommand?.name.split('.')[0]}
          onCloseTab={closeCommandWorkspace}
          onSelectTab={setSelectedCommandName}
          result={
            selectedCommand ? (
              renderCommandResult(selectedCommand.name) || (
                <p className="muted">Run this tool to see structured output in the workspace.</p>
              )
            ) : (
              <p className="muted">No tool selected.</p>
            )
          }
          subtitle={selectedCommand?.description || 'No description provided.'}
          tabs={workspaceCommandTabs}
          title={selectedCommand?.name}
        />

        <CommandInspectorPanel
          bridgeReady={bridgeReady}
          favorite={selectedCommand ? favoriteCommandSet.has(selectedCommand.name) : false}
          getFieldValue={getFieldValue}
          onClearPayload={clearPayloadDraft}
          onFieldChange={updateField}
          onLoadDefaults={loadSchemaDefaults}
          onLoadPayload={loadPayloadDraft}
          onRun={(command) => void runCommandFromMetadata(command)}
          onStartTask={(command) => void startTaskFromMetadata(command)}
          onToggleFavorite={toggleFavoriteCommand}
          invocation={selectedCommand ? commandInvocations[selectedCommand.name] : undefined}
          recentExecutions={recentExecutions}
          selectedCommand={selectedCommand}
        />
      </section>

      <ToolShellBottom
        bridgeReady={bridgeReady}
        callBridge={callBridge}
        callBridgeQuiet={callBridgeQuiet}
        commands={commands}
        eventLines={eventLines}
        log={log}
        logLines={logLines}
        onCancelTask={(taskId) => void cancelTask(taskId)}
        onClearLocalData={() => {
          clearRecentExecutions()
          resetToolPreferences()
        }}
        onRemoveTask={(taskId) => void removeTask(taskId)}
        onLoadTaskDetails={loadTaskDetails}
        persistenceEnabled={projectContext.persistenceEnabled}
        projectContextReady={projectContextReady}
        projectName={projectContext.projectName}
        taskList={taskList}
      />
    </main>
  )
}

export default App
