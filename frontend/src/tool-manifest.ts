import type { ReactNode } from 'react'
import toolCatalog from './tool-catalog.json'
import {
  isRecord,
  storedEnvelope,
  type StorageLoadResult,
} from './storage'

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

export const TOOL_PREFERENCES_STORAGE_KEY = 'unreal-editor-webui.toolPreferences'
export const TOOL_PREFERENCES_SCHEMA_VERSION = 1
export const MAX_FAVORITE_COMMANDS = 12
export const MAX_OPEN_TABS = 8

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
type ReadonlyToolPreferenceState = Omit<ToolPreferenceState, 'favorites' | 'openTabs'> & {
  readonly favorites: readonly string[]
  readonly openTabs: readonly string[]
}

export const DEFAULT_TOOL_PREFERENCES: ReadonlyToolPreferenceState = Object.freeze({
  ...CATALOG.defaultPreferences,
  favorites: Object.freeze([...CATALOG.defaultPreferences.favorites]),
  openTabs: Object.freeze([...CATALOG.defaultPreferences.openTabs]),
})

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

function cloneDefaultToolPreferences(): ToolPreferenceState {
  return {
    ...DEFAULT_TOOL_PREFERENCES,
    favorites: [...DEFAULT_TOOL_PREFERENCES.favorites],
    openTabs: [...DEFAULT_TOOL_PREFERENCES.openTabs],
  }
}

function normalizeStringList(value: unknown, fallback: string[], limit: number) {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= limit) {
      break
    }
  }
  return result
}

export function normalizeToolPreferences(value: unknown): ToolPreferenceState {
  const defaults = cloneDefaultToolPreferences()
  if (!isRecord(value)) {
    return defaults
  }

  const projectId = isToolProjectId(value.projectId) ? value.projectId : defaults.projectId
  const project = TOOL_PROJECTS.find((item) => item.id === projectId) || TOOL_PROJECTS[0]
  const requestedStageId = isToolStageId(value.stageId) ? value.stageId : defaults.stageId
  const stageId = project.stages.includes(requestedStageId)
    ? requestedStageId
    : project.stages.includes(defaults.stageId)
      ? defaults.stageId
      : project.stages[0] || defaults.stageId
  const categoryId = isToolCategoryId(value.categoryId) ? value.categoryId : defaults.categoryId

  return {
    projectId,
    stageId,
    categoryId,
    favorites: normalizeStringList(value.favorites, defaults.favorites, MAX_FAVORITE_COMMANDS),
    openTabs: normalizeStringList(value.openTabs, defaults.openTabs, MAX_OPEN_TABS),
  }
}

export function loadToolPreferencesState(): StorageLoadResult<ToolPreferenceState> {
  try {
    const stored = globalThis.localStorage?.getItem(TOOL_PREFERENCES_STORAGE_KEY)
    if (!stored) {
      return { value: cloneDefaultToolPreferences(), needsRewrite: false, source: 'missing' }
    }

    const parsed: unknown = JSON.parse(stored)
    if (isRecord(parsed) && parsed.schemaVersion === TOOL_PREFERENCES_SCHEMA_VERSION) {
      if (!isRecord(parsed.data)) {
        return {
          value: cloneDefaultToolPreferences(),
          needsRewrite: true,
          source: 'invalid',
        }
      }
      const value = normalizeToolPreferences(parsed.data)
      return {
        value,
        needsRewrite: JSON.stringify(value) !== JSON.stringify(parsed.data),
        source: 'current',
      }
    }

    if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')) {
      return {
        value: cloneDefaultToolPreferences(),
        needsRewrite: false,
        source: 'unsupported',
      }
    }
    if (isRecord(parsed)) {
      return {
        value: normalizeToolPreferences(parsed),
        needsRewrite: true,
        source: 'legacy',
      }
    }
    return { value: cloneDefaultToolPreferences(), needsRewrite: true, source: 'invalid' }
  } catch {
    return { value: cloneDefaultToolPreferences(), needsRewrite: true, source: 'invalid' }
  }
}

export function loadToolPreferences(): ToolPreferenceState {
  return loadToolPreferencesState().value
}

export function saveToolPreferences(preferences: ToolPreferenceState) {
  try {
    globalThis.localStorage?.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(storedEnvelope(TOOL_PREFERENCES_SCHEMA_VERSION, normalizeToolPreferences(preferences))),
    )
  } catch {
    // Embedded browser localStorage can be unavailable depending on context.
  }
}
