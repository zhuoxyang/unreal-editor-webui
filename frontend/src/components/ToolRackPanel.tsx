import type { ChangeEvent } from 'react'
import type { CommandsLoadStatus } from '../hooks/useCommands'
import type { ToolCategory, ToolCategoryId, ToolProject, ToolProjectId, ToolStage, ToolStageId } from '../tool-manifest'
import type { CommandLoadError } from '../types/command'

export type ToolRackCommand = {
  name: string
  description: string
  permission: string
  category?: string
  icon?: string
}

type ToolRackPanelProps = {
  commands: ToolRackCommand[]
  favoriteCommands: ToolRackCommand[]
  recentCommands: ToolRackCommand[]
  categories: ToolCategory[]
  projects: ToolProject[]
  stages: ToolStage[]
  selectedCommandName: string | null
  projectId: ToolProjectId
  stageId: ToolStageId
  categoryId: ToolCategoryId
  search: string
  shownCount: number
  commandsError: string
  commandsLoadErrors: CommandLoadError[]
  commandsStatus: CommandsLoadStatus
  onProjectChange: (projectId: ToolProjectId) => void
  onStageChange: (stageId: ToolStageId) => void
  onCategoryChange: (categoryId: ToolCategoryId) => void
  onSearchChange: (value: string) => void
  onOpenCommand: (commandName: string) => void
  onRetryCommands: () => void
}

function toolIcon(command: ToolRackCommand) {
  return command.icon || command.name[0]?.toUpperCase() || '?'
}

function ToolButton({
  command,
  active,
  onOpen,
}: {
  command: ToolRackCommand
  active: boolean
  onOpen: (commandName: string) => void
}) {
  return (
    <button
      className={active ? 'tool-rack-item active' : 'tool-rack-item'}
      type="button"
      onClick={() => onOpen(command.name)}
    >
      <span className="tool-rack-icon">{toolIcon(command)}</span>
      <span>
        <strong>{command.name}</strong>
        <small>{command.description || 'No description provided.'}</small>
      </span>
      <span className={`badge ${command.permission}`}>{command.permission}</span>
    </button>
  )
}

export function ToolRackPanel({
  commands,
  favoriteCommands,
  recentCommands,
  categories,
  projects,
  stages,
  selectedCommandName,
  projectId,
  stageId,
  categoryId,
  search,
  shownCount,
  commandsError,
  commandsLoadErrors,
  commandsStatus,
  onProjectChange,
  onStageChange,
  onCategoryChange,
  onSearchChange,
  onOpenCommand,
  onRetryCommands,
}: ToolRackPanelProps) {
  return (
    <aside className="panel tool-rack-panel lightbox-rack">
      <div className="tool-rack-top">
        <div className="panel-title-row">
          <h2>Tool Rack</h2>
          <span>{shownCount} tools</span>
        </div>
        <select
          value={projectId}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onProjectChange(event.target.value as ToolProjectId)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="stage-tabs">
          {stages.map((stage) => (
            <button
              className={stage.id === stageId ? 'stage-tab active' : 'stage-tab'}
              key={stage.id}
              type="button"
              onClick={() => onStageChange(stage.id)}
            >
              {stage.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          placeholder="Search tools"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="category-rail">
        {categories.map((category) => (
          <button
            className={category.id === categoryId ? 'category-button active' : 'category-button'}
            key={category.id}
            title={category.label}
            type="button"
            onClick={() => onCategoryChange(category.id)}
          >
            {category.icon}
          </button>
        ))}
      </div>

      <div className="tool-rack-scroll">
        {favoriteCommands.length > 0 ? (
          <div className="tool-rack-section icon-grid-section">
            <h3>Favorites</h3>
            <div className="tool-icon-grid">
              {favoriteCommands.map((command) => (
                <button
                  className={selectedCommandName === command.name ? 'tool-icon-card active' : 'tool-icon-card'}
                  key={`favorite-${command.name}`}
                  type="button"
                  onClick={() => onOpenCommand(command.name)}
                >
                  <span className="large-tool-icon">{toolIcon(command)}</span>
                  <strong>{command.name}</strong>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {recentCommands.length > 0 ? (
          <div className="tool-rack-section">
            <h3>Recent</h3>
            {recentCommands.map((command) => (
              <ToolButton
                active={selectedCommandName === command.name}
                command={command}
                key={`recent-${command.name}`}
                onOpen={onOpenCommand}
              />
            ))}
          </div>
        ) : null}

        <div className="tool-rack-section">
          <h3>Tools</h3>
          {commandsStatus === 'loading' && commands.length === 0 ? (
            <p className="muted" role="status">Loading tools…</p>
          ) : null}
          {commandsStatus === 'error' ? (
            <div className="inline-error" role="alert">
              <p>{commandsError}</p>
              <button type="button" onClick={onRetryCommands}>Retry loading tools</button>
            </div>
          ) : null}
          {commandsLoadErrors.length > 0 ? (
            <div className="inline-warning" role="status">
              <p>
                {commandsLoadErrors.length} command {commandsLoadErrors.length === 1 ? 'module is' : 'modules are'} unavailable.
              </p>
              <ul>
                {commandsLoadErrors.slice(0, 5).map((loadError, index) => (
                  <li key={`${loadError.module}-${index}`}>
                    <strong>{loadError.module}</strong>: {loadError.error}
                  </li>
                ))}
              </ul>
              {commandsLoadErrors.length > 5 ? <p>And {commandsLoadErrors.length - 5} more.</p> : null}
            </div>
          ) : null}
          {commands.length > 0 ? (
            commands.map((command) => (
              <ToolButton
                active={selectedCommandName === command.name}
                command={command}
                key={command.name}
                onOpen={onOpenCommand}
              />
            ))
          ) : commandsStatus !== 'loading' && commandsStatus !== 'error' ? (
            <p className="muted">No tools match the current filters.</p>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
