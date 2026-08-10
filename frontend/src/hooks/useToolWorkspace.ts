import { useMemo } from 'react'
import type { RecentExecution } from '../recent-executions'
import {
  commandCategoryId,
  commandSupportsStage,
  type ToolPreferenceState,
} from '../tool-manifest'
import { STARTER_TOOL_CATALOG, type ToolCatalogV1 } from '../tool-catalog'
import type { CommandMetadata } from '../types/command'

type UseToolWorkspaceOptions = {
  commands: CommandMetadata[]
  commandSearch: string
  favoriteCommands: string[]
  recentExecutions: RecentExecution[]
  selectedCommandName: string | null
  toolPreferences: ToolPreferenceState
  workspaceTabs: string[]
  catalog?: ToolCatalogV1
}

export function useToolWorkspace({
  commands,
  commandSearch,
  favoriteCommands,
  recentExecutions,
  selectedCommandName,
  toolPreferences,
  workspaceTabs,
  catalog = STARTER_TOOL_CATALOG,
}: UseToolWorkspaceOptions) {
  const activeProject = catalog.projects.find((project) => project.id === toolPreferences.projectId)
    || catalog.projects.find((project) => project.id === catalog.defaultPreferences.projectId)
    || catalog.projects[0]
  const availableStages = activeProject.stages
    .map((stageId) => catalog.stages.find((stage) => stage.id === stageId))
    .filter((stage): stage is ToolCatalogV1['stages'][number] => Boolean(stage))

  const filteredCommands = useMemo(() => {
    const search = commandSearch.trim().toLowerCase()

    return commands.filter((command) => {
      const matchesStage = commandSupportsStage(command, toolPreferences.stageId, catalog)
      const categoryId = commandCategoryId(command, catalog)
      const matchesCategory =
        toolPreferences.categoryId === 'all' ||
        (toolPreferences.categoryId === 'favorites' && favoriteCommands.includes(command.name)) ||
        (toolPreferences.categoryId === 'recent' && recentExecutions.some((item) => item.command === command.name)) ||
        categoryId === toolPreferences.categoryId
      const searchText = `${command.name} ${command.description} ${command.category || ''} ${(command.tags || []).join(' ')}`.toLowerCase()
      return matchesStage && matchesCategory && (!search || searchText.includes(search))
    })
  }, [catalog, commands, commandSearch, favoriteCommands, recentExecutions, toolPreferences.categoryId, toolPreferences.stageId])

  const selectedCommand = useMemo(() => {
    if (selectedCommandName) {
      return commands.find((command) => command.name === selectedCommandName) || filteredCommands[0] || null
    }

    return filteredCommands[0] || null
  }, [commands, filteredCommands, selectedCommandName])

  const recentCommandNames = useMemo(() => {
    return Array.from(new Set(recentExecutions.map((item) => item.command))).slice(0, 6)
  }, [recentExecutions])

  const favoriteCommandSet = useMemo(() => new Set(favoriteCommands), [favoriteCommands])

  const visibleFavoriteCommands = useMemo(() => {
    return favoriteCommands
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
  }, [commands, favoriteCommands])

  const visibleRecentCommands = useMemo(() => {
    return recentCommandNames
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
  }, [commands, recentCommandNames])

  const openWorkspaceCommandNames = useMemo(() => {
    const names = workspaceTabs.filter((name) => commands.some((command) => command.name === name))
    if (selectedCommand && !names.includes(selectedCommand.name)) {
      return [selectedCommand.name, ...names]
    }

    return names
  }, [commands, selectedCommand, workspaceTabs])

  const workspaceCommandTabs = useMemo(() => {
    return openWorkspaceCommandNames
      .map((name) => commands.find((command) => command.name === name))
      .filter((command): command is CommandMetadata => Boolean(command))
      .map((command) => ({
        name: command.name,
        icon: command.icon,
      }))
  }, [commands, openWorkspaceCommandNames])

  return {
    availableStages,
    favoriteCommandSet,
    filteredCommands,
    selectedCommand,
    visibleFavoriteCommands,
    visibleRecentCommands,
    workspaceCommandTabs,
  }
}
