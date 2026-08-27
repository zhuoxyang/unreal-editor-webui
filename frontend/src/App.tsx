import { useCallback, useMemo, useState } from 'react'
import './App.css'
import { BridgeHealthPanel } from './components/BridgeHealthPanel'
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
import { toolPackStatusReasonCodes, useToolPackStatus } from './hooks/useToolPackStatus'
import { useRecentExecutions } from './hooks/useRecentExecutions'
import { useProjectContext } from './hooks/useProjectContext'
import { useTasks } from './hooks/useTasks'
import { useToolPreferences } from './hooks/useToolPreferences'
import { useToolCatalog } from './hooks/useToolCatalog'
import { useToolWorkspace } from './hooks/useToolWorkspace'
import { useWebUIHealth } from './hooks/useWebUIHealth'
import { hasCommandResult } from './schema-form'
import type { SupportReportInput } from './support-report'
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
  const {
    projectContext,
    projectContextReady,
    projectContextStatus,
  } = useProjectContext({ bridgeReady, callBridgeQuiet, log })
  const {
    canRetryHealth,
    health,
    healthDiagnosticCode,
    healthStatus,
    retryHealth,
  } = useWebUIHealth({ bridgeReady, callBridgeQuiet, log })
  const {
    canAutoRewrite,
    canRetryCatalog,
    catalog,
    catalogDiagnosticCode,
    catalogDiagnostic,
    catalogReady,
    catalogSource,
    catalogStatus,
    retryCatalog,
  } = useToolCatalog({ bridgeReady, callBridgeQuiet, log })
  const { commands, commandsError, commandsLoadErrors, commandsStatus, retryCommands } = useCommands({
    bridgeReady,
    callBridgeQuiet,
    log,
  })
  const {
    canRetryToolPackStatus,
    retryToolPackStatus,
    toolPackStatus,
    toolPackStatusDiagnosticCode,
    toolPackStatusLoadStatus,
  } = useToolPackStatus({
    bridgeReady,
    commandsStatus,
    commandAvailable: commands.some((command) => command.name === 'system.toolPacks'),
    callBridgeQuiet,
    log,
  })
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
  } = useToolPreferences(projectContext.storageNamespace, catalog, {
    catalogReady: projectContextReady && catalogReady,
    canAutoRewrite,
  })
  const {
    cancelTask,
    eventLines,
    loadTaskDetails,
    mergeTaskResult,
    removeTask,
    taskList,
  } = useTasks({ bridgeReady, callBridge, callBridgeQuiet, log })

  const taskCounts = useMemo(() => {
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
    }
    for (const task of taskList) {
      if (task.status === 'timed_out') {
        counts.timedOut += 1
      } else if (task.status in counts) {
        counts[task.status as keyof Omit<typeof counts, 'timedOut'>] += 1
      }
    }
    return counts
  }, [taskList])

  const supportReportInput: SupportReportInput = {
    protocolVersion: health?.protocolVersion ?? null,
    bridgeProtocolVersion: health?.bridgeProtocolVersion ?? null,
    pluginVersion: health?.pluginVersion ?? null,
    engineVersion: health?.engineVersion ?? null,
    documentScope: health?.documentScope ?? null,
    pythonRuntime: health?.pythonRuntime ?? null,
    privilegedConfirmation: health?.privilegedConfirmation ?? null,
    taskSessionIsolation: health?.taskSessionIsolation ?? null,
    bridgeLifecycle: healthStatus,
    bridgeDiagnosticCode: healthDiagnosticCode,
    projectPersistenceStatus: projectContextStatus === 'loading'
      ? 'loading'
      : projectContext.persistenceEnabled
        ? 'enabled'
        : 'disabled',
    registryStatus: commandsStatus,
    registryAvailableCount: commands.length,
    registryLoadErrorCount: commandsLoadErrors.length,
    catalogStatus,
    catalogSource,
    catalogSchemaVersion: catalog.schemaVersion,
    catalogDiagnosticCode,
    toolPackStatus: toolPackStatusLoadStatus,
    toolPackDiagnosticCode: toolPackStatusDiagnosticCode,
    toolPackStatusVersion: toolPackStatus?.statusVersion ?? null,
    toolPackCoreApiVersion: toolPackStatus?.coreApiVersion ?? null,
    toolPackLoadedCount: toolPackStatus?.packs.filter((pack) => pack.state === 'loaded').length ?? 0,
    toolPackRejectedCount: toolPackStatus?.packs.filter((pack) => pack.state === 'rejected').length ?? 0,
    toolPackTruncatedCount: toolPackStatus?.truncatedCount ?? 0,
    toolPackReasonCodes: toolPackStatus ? toolPackStatusReasonCodes(toolPackStatus) : [],
    queuedTaskCount: taskCounts.queued,
    runningTaskCount: taskCounts.running,
    completedTaskCount: taskCounts.completed,
    failedTaskCount: taskCounts.failed,
    cancelledTaskCount: taskCounts.cancelled,
    timedOutTaskCount: taskCounts.timedOut,
  }

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
    catalog,
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
    <main
      className="app-shell tool-shell"
      data-tool-catalog-source={catalogSource}
      data-tool-catalog-schema-version={catalog.schemaVersion}
    >
      <ToolShellHeader
        catalogSchemaVersion={catalog.schemaVersion}
        catalogSource={catalogSource}
        catalogStatus={catalogStatus}
        healthPanel={(
          <BridgeHealthPanel
            canRetryHealth={canRetryHealth}
            health={health}
            healthStatus={healthStatus}
            onRetryHealth={retryHealth}
            supportReportInput={supportReportInput}
            toolPackStatus={toolPackStatus}
            toolPackStatusLoadStatus={toolPackStatusLoadStatus}
            toolPackStatusDiagnosticCode={toolPackStatusDiagnosticCode}
            canRetryToolPackStatus={canRetryToolPackStatus}
            onRetryToolPackStatus={retryToolPackStatus}
          />
        )}
      />

      <section className="tool-shell-layout">
        <ToolRackPanel
          categories={catalog.categories}
          catalogDiagnostic={catalogDiagnostic}
          catalogStatus={catalogStatus}
          canRetryCatalog={canRetryCatalog}
          commandsError={commandsError}
          commandsLoadErrors={commandsLoadErrors}
          commandsStatus={commandsStatus}
          categoryId={toolPreferences.categoryId}
          commands={filteredCommands}
          favoriteCommands={visibleFavoriteCommands}
          onCategoryChange={updateToolCategory}
          onOpenCommand={openCommandWorkspace}
          onProjectChange={updateToolProject}
          onRetryCatalog={retryCatalog}
          onRetryCommands={() => void retryCommands()}
          onSearchChange={setCommandSearch}
          onStageChange={updateToolStage}
          projectId={toolPreferences.projectId}
          projects={catalog.projects}
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
