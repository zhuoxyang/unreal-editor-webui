import { InspectorPanel } from './InspectorPanel'
import { SchemaForm } from './SchemaForm'
import type { RecentExecution } from '../recent-executions'
import type { CommandMetadata, DraftValue, SchemaProperty } from '../types/command'
import type { CommandInvocationState } from '../hooks/useCommandRunner'

type CommandInspectorPanelProps = {
  bridgeReady: boolean
  favorite: boolean
  invocation?: CommandInvocationState
  recentExecutions: RecentExecution[]
  selectedCommand: CommandMetadata | null
  getFieldValue: (command: CommandMetadata, fieldName: string, property: SchemaProperty) => DraftValue
  onClearPayload: (command: CommandMetadata) => void
  onFieldChange: (commandName: string, fieldName: string, value: DraftValue) => void
  onLoadDefaults: (command: CommandMetadata) => void
  onLoadPayload: (command: CommandMetadata, payload: Record<string, unknown>) => void
  onRun: (command: CommandMetadata) => void
  onStartTask: (command: CommandMetadata) => void
  onToggleFavorite: (commandName: string) => void
}

export function CommandInspectorPanel({
  bridgeReady,
  favorite,
  getFieldValue,
  onClearPayload,
  onFieldChange,
  onLoadDefaults,
  onLoadPayload,
  onRun,
  onStartTask,
  onToggleFavorite,
  recentExecutions,
  selectedCommand,
  invocation,
}: CommandInspectorPanelProps) {
  const pending = invocation?.status === 'pending'

  return (
    <InspectorPanel
      favoriteLabel={selectedCommand ? (favorite ? 'Unfavorite' : 'Favorite') : undefined}
      onToggleFavorite={selectedCommand ? () => onToggleFavorite(selectedCommand.name) : undefined}
    >
      {selectedCommand ? (
        <>
          <SchemaForm
            command={selectedCommand}
            getFieldValue={getFieldValue}
            onClear={onClearPayload}
            onFieldChange={onFieldChange}
            onLoadDefaults={onLoadDefaults}
            onLoadPayload={onLoadPayload}
            recentExecutions={recentExecutions}
          />
          <div className="command-actions">
            <button type="button" onClick={() => onRun(selectedCommand)} disabled={!bridgeReady || pending}>
              {pending && invocation.mode === 'run' ? 'Running…' : 'Run'}
            </button>
            <button type="button" onClick={() => onStartTask(selectedCommand)} disabled={!bridgeReady || pending}>
              {pending && invocation.mode === 'task' ? 'Starting…' : 'Start task'}
            </button>
          </div>
          {invocation?.status === 'error' ? (
            <p className="command-invocation-message error" role="alert">{invocation.error}</p>
          ) : null}
          {invocation?.status === 'pending' || invocation?.status === 'success' ? (
            <p className="command-invocation-message" role="status">{invocation.message}</p>
          ) : null}
          <details>
            <summary>Schema</summary>
            <pre>{JSON.stringify(selectedCommand.schema, null, 2)}</pre>
          </details>
        </>
      ) : (
        <p className="muted">Select a tool to inspect its inputs.</p>
      )}
    </InspectorPanel>
  )
}

