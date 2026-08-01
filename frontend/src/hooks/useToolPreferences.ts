import { useEffect, useRef, useState, type SetStateAction } from 'react'
import {
  clearToolPreferences,
  loadToolPreferencesState,
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  saveToolPreferences,
  TOOL_PROJECTS,
  type ToolCategoryId,
  type ToolProjectId,
  type ToolStageId,
} from '../tool-manifest'

export function useToolPreferences(storageNamespace?: string | null) {
  const [initialLoad] = useState(() => loadToolPreferencesState(storageNamespace))
  const [toolPreferences, setToolPreferences] = useState(initialLoad.value)
  const [workspaceTabs, setWorkspaceTabs] = useState<string[]>(initialLoad.value.openTabs)
  const [favoriteCommands, setFavoriteCommands] = useState<string[]>(initialLoad.value.favorites)
  const hasUserChangedRef = useRef(false)
  const hasMountedRef = useRef(false)
  const suppressNextSaveRef = useRef(false)

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      if (initialLoad.needsRewrite) {
        saveToolPreferences(initialLoad.value, storageNamespace)
      }
      return
    }

    const loaded = loadToolPreferencesState(storageNamespace)
    hasUserChangedRef.current = false
    suppressNextSaveRef.current = true
    setToolPreferences(loaded.value)
    setWorkspaceTabs(loaded.value.openTabs)
    setFavoriteCommands(loaded.value.favorites)
    if (loaded.needsRewrite) {
      saveToolPreferences(loaded.value, storageNamespace)
    }
  }, [initialLoad, storageNamespace])

  useEffect(() => {
    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false
      return
    }
    if (!hasUserChangedRef.current) {
      return
    }
    saveToolPreferences({
      ...toolPreferences,
      favorites: favoriteCommands,
      openTabs: workspaceTabs,
    }, storageNamespace)
    hasUserChangedRef.current = false
  }, [favoriteCommands, storageNamespace, toolPreferences, workspaceTabs])

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

  function resetToolPreferences() {
    clearToolPreferences(storageNamespace)
    const defaults = loadToolPreferencesState(storageNamespace).value
    hasUserChangedRef.current = true
    setToolPreferences(defaults)
    setFavoriteCommands(defaults.favorites)
    setWorkspaceTabs(defaults.openTabs)
  }

  return {
    closeWorkspaceCommand,
    favoriteCommands,
    openWorkspaceCommand,
    resetToolPreferences,
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
