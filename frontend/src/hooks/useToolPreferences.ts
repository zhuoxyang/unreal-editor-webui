import { useEffect, useRef, useState, type SetStateAction } from 'react'
import {
  clearToolPreferences,
  loadToolPreferencesState,
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  saveToolPreferences,
  type ToolCategoryId,
  type ToolProjectId,
  type ToolStageId,
} from '../tool-manifest'
import { STARTER_TOOL_CATALOG, type ToolCatalogV1 } from '../tool-catalog'

type ToolPreferenceRuntimeOptions = {
  catalogReady?: boolean
  canAutoRewrite?: boolean
}

export function useToolPreferences(
  storageNamespace?: string | null,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
  {
    catalogReady = true,
    canAutoRewrite = true,
  }: ToolPreferenceRuntimeOptions = {},
) {
  const [initialLoad] = useState(() => loadToolPreferencesState(
    catalogReady ? storageNamespace : null,
    catalog,
  ))
  const [toolPreferences, setToolPreferences] = useState(initialLoad.value)
  const [workspaceTabs, setWorkspaceTabs] = useState<string[]>(initialLoad.value.openTabs)
  const [favoriteCommands, setFavoriteCommands] = useState<string[]>(initialLoad.value.favorites)
  const hasUserChangedRef = useRef(false)
  const suppressNextSaveRef = useRef(false)

  useEffect(() => {
    if (!catalogReady) {
      return
    }

    let stopped = false
    const loaded = loadToolPreferencesState(storageNamespace, catalog)
    hasUserChangedRef.current = false
    suppressNextSaveRef.current = true
    if (loaded.needsRewrite && canAutoRewrite) {
      saveToolPreferences(loaded.value, storageNamespace, catalog)
    }
    void Promise.resolve().then(() => {
      if (stopped) return
      setToolPreferences(loaded.value)
      setWorkspaceTabs(loaded.value.openTabs)
      setFavoriteCommands(loaded.value.favorites)
    })
    return () => {
      stopped = true
    }
  }, [canAutoRewrite, catalog, catalogReady, storageNamespace])

  useEffect(() => {
    if (!catalogReady || !canAutoRewrite) {
      return
    }
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
    }, storageNamespace, catalog)
    hasUserChangedRef.current = false
  }, [canAutoRewrite, catalog, catalogReady, favoriteCommands, storageNamespace, toolPreferences, workspaceTabs])

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
      const project = catalog.projects.find((item) => item.id === projectId)
      if (!project) return preferences
      const nextStage = project.stages.includes(preferences.stageId)
        ? preferences.stageId
        : project.stages.includes(catalog.defaultPreferences.stageId)
          ? catalog.defaultPreferences.stageId
          : project.stages[0]
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
      const project = catalog.projects.find((item) => item.id === preferences.projectId)
        || catalog.projects.find((item) => item.id === catalog.defaultPreferences.projectId)
        || catalog.projects[0]
      return project.stages.includes(stageId) ? { ...preferences, stageId } : preferences
    })
  }

  function updateToolCategory(categoryId: ToolCategoryId) {
    hasUserChangedRef.current = true
    setToolPreferences((preferences) => (
      catalog.categories.some((category) => category.id === categoryId)
        ? { ...preferences, categoryId }
        : preferences
    ))
  }

  function resetToolPreferences() {
    clearToolPreferences(storageNamespace)
    const defaults = loadToolPreferencesState(storageNamespace, catalog).value
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
