import { useEffect, useRef, useState, type SetStateAction } from 'react'
import {
  loadToolPreferencesState,
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  saveToolPreferences,
  TOOL_PROJECTS,
  type ToolCategoryId,
  type ToolProjectId,
  type ToolStageId,
} from '../tool-manifest'

export function useToolPreferences() {
  const [initialLoad] = useState(loadToolPreferencesState)
  const [toolPreferences, setToolPreferences] = useState(initialLoad.value)
  const [workspaceTabs, setWorkspaceTabs] = useState<string[]>(toolPreferences.openTabs)
  const [favoriteCommands, setFavoriteCommands] = useState<string[]>(toolPreferences.favorites)
  const hasUserChangedRef = useRef(false)

  useEffect(() => {
    if (!initialLoad.needsRewrite && !hasUserChangedRef.current) {
      return
    }
    saveToolPreferences({
      ...toolPreferences,
      favorites: favoriteCommands,
      openTabs: workspaceTabs,
    })
  }, [favoriteCommands, initialLoad.needsRewrite, toolPreferences, workspaceTabs])

  function replaceWorkspaceTabs(value: SetStateAction<string[]>) {
    hasUserChangedRef.current = true
    setWorkspaceTabs(value)
  }

  function replaceFavoriteCommands(value: SetStateAction<string[]>) {
    hasUserChangedRef.current = true
    setFavoriteCommands(value)
  }

  function openWorkspaceCommand(commandName: string) {
    replaceWorkspaceTabs((tabs) => (
      tabs.includes(commandName) ? tabs : [commandName, ...tabs].slice(0, MAX_OPEN_TABS)
    ))
  }

  function closeWorkspaceCommand(commandName: string, selectedCommandName: string | null, onSelect: (name: string | null) => void) {
    replaceWorkspaceTabs((tabs) => {
      const nextTabs = tabs.filter((name) => name !== commandName)
      if (selectedCommandName === commandName) {
        onSelect(nextTabs[0] || null)
      }
      return nextTabs
    })
  }

  function toggleFavoriteCommand(commandName: string) {
    replaceFavoriteCommands((items) =>
      items.includes(commandName)
        ? items.filter((name) => name !== commandName)
        : [commandName, ...items].slice(0, MAX_FAVORITE_COMMANDS),
    )
  }

  function updateToolProject(projectId: ToolProjectId) {
    hasUserChangedRef.current = true
    setToolPreferences((preferences) => {
      const project = TOOL_PROJECTS.find((item) => item.id === projectId) || TOOL_PROJECTS[0]
      const nextStage = project.stages.includes(preferences.stageId) ? preferences.stageId : project.stages[0]
      return {
        ...preferences,
        projectId: project.id,
        stageId: nextStage,
      }
    })
  }

  function updateToolStage(stageId: ToolStageId) {
    hasUserChangedRef.current = true
    setToolPreferences((preferences) => {
      const project = TOOL_PROJECTS.find((item) => item.id === preferences.projectId) || TOOL_PROJECTS[0]
      return project.stages.includes(stageId) ? { ...preferences, stageId } : preferences
    })
  }

  function updateToolCategory(categoryId: ToolCategoryId) {
    hasUserChangedRef.current = true
    setToolPreferences((preferences) => ({
      ...preferences,
      categoryId,
    }))
  }

  return {
    closeWorkspaceCommand,
    favoriteCommands,
    openWorkspaceCommand,
    setFavoriteCommands: replaceFavoriteCommands,
    setWorkspaceTabs: replaceWorkspaceTabs,
    toggleFavoriteCommand,
    toolPreferences,
    updateToolCategory,
    updateToolProject,
    updateToolStage,
    workspaceTabs,
  }
}

