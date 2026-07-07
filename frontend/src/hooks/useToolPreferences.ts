import { useEffect, useState } from 'react'
import {
  loadToolPreferences,
  saveToolPreferences,
  TOOL_PROJECTS,
  type ToolCategoryId,
  type ToolProjectId,
  type ToolStageId,
} from '../tool-manifest'

export function useToolPreferences() {
  const [toolPreferences, setToolPreferences] = useState(loadToolPreferences)
  const [workspaceTabs, setWorkspaceTabs] = useState<string[]>(toolPreferences.openTabs)
  const [favoriteCommands, setFavoriteCommands] = useState<string[]>(toolPreferences.favorites)

  useEffect(() => {
    saveToolPreferences({
      ...toolPreferences,
      favorites: favoriteCommands,
      openTabs: workspaceTabs,
    })
  }, [favoriteCommands, toolPreferences, workspaceTabs])

  function openWorkspaceCommand(commandName: string) {
    setWorkspaceTabs((tabs) => (tabs.includes(commandName) ? tabs : [commandName, ...tabs].slice(0, 8)))
  }

  function closeWorkspaceCommand(commandName: string, selectedCommandName: string | null, onSelect: (name: string | null) => void) {
    setWorkspaceTabs((tabs) => {
      const nextTabs = tabs.filter((name) => name !== commandName)
      if (selectedCommandName === commandName) {
        onSelect(nextTabs[0] || null)
      }
      return nextTabs
    })
  }

  function toggleFavoriteCommand(commandName: string) {
    setFavoriteCommands((items) =>
      items.includes(commandName) ? items.filter((name) => name !== commandName) : [commandName, ...items].slice(0, 12),
    )
  }

  function updateToolProject(projectId: ToolProjectId) {
    const project = TOOL_PROJECTS.find((item) => item.id === projectId) || TOOL_PROJECTS[0]
    const nextStage = project.stages.includes(toolPreferences.stageId) ? toolPreferences.stageId : project.stages[0]
    setToolPreferences((preferences) => ({
      ...preferences,
      projectId,
      stageId: nextStage,
    }))
  }

  function updateToolStage(stageId: ToolStageId) {
    setToolPreferences((preferences) => ({
      ...preferences,
      stageId,
    }))
  }

  function updateToolCategory(categoryId: ToolCategoryId) {
    setToolPreferences((preferences) => ({
      ...preferences,
      categoryId,
    }))
  }

  return {
    closeWorkspaceCommand,
    favoriteCommands,
    openWorkspaceCommand,
    setFavoriteCommands,
    setWorkspaceTabs,
    toggleFavoriteCommand,
    toolPreferences,
    updateToolCategory,
    updateToolProject,
    updateToolStage,
    workspaceTabs,
  }
}

