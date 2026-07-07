import { useMemo } from 'react'
import type { RecentExecution } from '../recent-executions'
import {
  commandCategoryId,
  commandSupportsStage,
  TOOL_PROJECTS,
  TOOL_STAGES,
  type ToolPreferenceState,
} from '../tool-manifest'
import type { CommandMetadata } from '../types/command'

type UseToolWorkspaceOptions = {
  commands: CommandMetadata[]
  commandSearch: string
  favoriteCommands: string[]
  recentExecutions: RecentExecution[]
  selectedCommandName: string | null
  toolPreferences: ToolPreferenceState
  workspaceTabs: string[]
}

export function useToolWorkspace({
  commands,
  commandSearch,
  favoriteCommands,
  recentExecutions,
  selectedCommandName,
  toolPreferences,
  workspaceTabs,
}: UseToolWorkspaceOptions) {
  const activeProject = TOOL_PROJECTS.find((project) => project.id === toolPreferences.projectId) || TOOL_PROJECTS[0]
  const availableStages = TOOL_STAGES.filter((stage) => activeProject.stages.includes(stage.id))

  const filteredCommands = useMemo(() => {
    const search = commandSearch.trim().toLowerCase()

    return commands.filter((command) => {
      const matchesStage = commandSupportsStage(command, toolPreferences.stageId)
      const categoryId = commandCategoryId(command)
      const matchesCategory =
        toolPreferences.categoryId === 'all' ||
        (toolPreferences.categoryId === 'favorites' && favoriteCommands.includes(command.name)) ||
        (toolPreferences.categoryId === 'recent' && recentExecutions.some((item) => item.command === command.name)) ||
        categoryId === toolPreferences.categoryId
      const searchText = `${command.name} ${command.description} ${command.category || ''} ${(command.tags || []).join(' ')}`.toLowerCase()
      return matchesStage && matchesCategory && (!search || searchText.includes(search))
    })
  }, [commands, commandSearch, favoriteCommands, recentExecutions, toolPreferences.categoryId, toolPreferences.stageId])

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

