import type { ReactNode } from 'react'
import toolCatalog from './tool-catalog.json'

export type ToolProjectId = 'aurora' | 'neon' | 'mobile'
export type ToolStageId = 'common' | 'art' | 'ta' | 'level' | 'release'
export type ToolCategoryId = 'all' | 'favorites' | 'recent' | 'assets' | 'materials' | 'level' | 'release' | 'system'

export type ToolProject = {
  id: ToolProjectId
  name: string
  description: string
  stages: ToolStageId[]
}

export type ToolStage = {
  id: ToolStageId
  label: string
}

export type ToolCategory = {
  id: ToolCategoryId
  label: string
  icon: string
}

export type ToolPreferenceState = {
  projectId: ToolProjectId
  stageId: ToolStageId
  categoryId: ToolCategoryId
  favorites: string[]
  openTabs: string[]
}

export type ToolShellPanel = {
  id: string
  title: string
  content: ReactNode
}

const TOOL_PREFERENCES_STORAGE_KEY = 'unreal-editor-webui.toolPreferences'

type ToolCatalog = {
  projects: ToolProject[]
  stages: ToolStage[]
  categories: ToolCategory[]
  defaultPreferences: ToolPreferenceState
}

const CATALOG = toolCatalog as ToolCatalog

export const TOOL_PROJECTS = CATALOG.projects
export const TOOL_STAGES = CATALOG.stages
export const TOOL_CATEGORIES = CATALOG.categories
export const DEFAULT_TOOL_PREFERENCES = CATALOG.defaultPreferences

function isToolProjectId(value: unknown): value is ToolProjectId {
  return TOOL_PROJECTS.some((project) => project.id === value)
}

function isToolStageId(value: unknown): value is ToolStageId {
  return TOOL_STAGES.some((stage) => stage.id === value)
}

function isToolCategoryId(value: unknown): value is ToolCategoryId {
  return TOOL_CATEGORIES.some((category) => category.id === value)
}

export function commandCategoryId(command: {
  category?: string
  tags?: string[]
  name: string
}): ToolCategoryId {
  const haystack = `${command.category || ''} ${(command.tags || []).join(' ')} ${command.name}`.toLowerCase()

  if (haystack.includes('material') || haystack.includes('texture')) return 'materials'
  if (haystack.includes('level') || haystack.includes('blueprint')) return 'level'
  if (haystack.includes('release') || haystack.includes('gate') || haystack.includes('perf')) return 'release'
  if (haystack.includes('system') || haystack.includes('demo') || haystack.includes('editor')) return 'system'
  return 'assets'
}

export function commandSupportsStage(command: { tags?: string[]; category?: string; name: string }, stageId: ToolStageId) {
  if (stageId === 'common') return true
  const haystack = `${command.category || ''} ${(command.tags || []).join(' ')} ${command.name}`.toLowerCase()

  if (stageId === 'art') return /(asset|material|texture|rename|editor)/.test(haystack)
  if (stageId === 'ta') return /(asset|material|texture|blueprint|perf|demo|task)/.test(haystack)
  if (stageId === 'level') return /(level|blueprint|asset|editor)/.test(haystack)
  if (stageId === 'release') return /(release|gate|perf|asset|rename|system)/.test(haystack)
  return true
}

export function loadToolPreferences(): ToolPreferenceState {
  try {
    const stored = globalThis.localStorage?.getItem(TOOL_PREFERENCES_STORAGE_KEY)
    if (!stored) {
      return DEFAULT_TOOL_PREFERENCES
    }

    const parsed = JSON.parse(stored) as Partial<ToolPreferenceState>
    const projectId = isToolProjectId(parsed.projectId) ? parsed.projectId : DEFAULT_TOOL_PREFERENCES.projectId
    const stageId = isToolStageId(parsed.stageId) ? parsed.stageId : DEFAULT_TOOL_PREFERENCES.stageId
    const categoryId = isToolCategoryId(parsed.categoryId) ? parsed.categoryId : DEFAULT_TOOL_PREFERENCES.categoryId

    return {
      projectId,
      stageId,
      categoryId,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((item) => typeof item === 'string') : DEFAULT_TOOL_PREFERENCES.favorites,
      openTabs: Array.isArray(parsed.openTabs) ? parsed.openTabs.filter((item) => typeof item === 'string') : [],
    }
  } catch {
    return DEFAULT_TOOL_PREFERENCES
  }
}

export function saveToolPreferences(preferences: ToolPreferenceState) {
  try {
    globalThis.localStorage?.setItem(TOOL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Embedded browser localStorage can be unavailable depending on context.
  }
}
