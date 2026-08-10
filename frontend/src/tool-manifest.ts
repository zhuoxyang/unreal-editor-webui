import type { ReactNode } from 'react'
import {
  isRecord,
  namespacedStorageKey,
  storedEnvelope,
  type StorageLoadResult,
} from './storage'
import {
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  STARTER_TOOL_CATALOG,
  isReservedToolCategoryId,
  type ToolCatalogV1,
  type ToolCategoryId,
  type ToolProjectId,
  type ToolStageId,
} from './tool-catalog'

export {
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  type ToolCategory,
  type ToolCategoryId,
  type ToolProject,
  type ToolProjectId,
  type ToolStage,
  type ToolStageId,
} from './tool-catalog'

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

export const TOOL_PROJECTS = STARTER_TOOL_CATALOG.projects
export const TOOL_STAGES = STARTER_TOOL_CATALOG.stages
export const TOOL_CATEGORIES = STARTER_TOOL_CATALOG.categories
type ReadonlyToolPreferenceState = Omit<ToolPreferenceState, 'favorites' | 'openTabs'> & {
  readonly favorites: readonly string[]
  readonly openTabs: readonly string[]
}

export const DEFAULT_TOOL_PREFERENCES: ReadonlyToolPreferenceState = Object.freeze({
  ...STARTER_TOOL_CATALOG.defaultPreferences,
  favorites: Object.freeze([...STARTER_TOOL_CATALOG.defaultPreferences.favorites]),
  openTabs: Object.freeze([...STARTER_TOOL_CATALOG.defaultPreferences.openTabs]),
})

export function commandCategoryId(command: {
  category?: string
  tags?: string[]
  name: string
}, catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG): ToolCategoryId | null {
  if (catalog === STARTER_TOOL_CATALOG) {
    const haystack = `${command.category || ''} ${(command.tags || []).join(' ')} ${command.name}`.toLowerCase()
    let categoryId = 'assets'
    if (haystack.includes('material') || haystack.includes('texture')) categoryId = 'materials'
    else if (haystack.includes('level') || haystack.includes('blueprint')) categoryId = 'level'
    else if (haystack.includes('release') || haystack.includes('gate') || haystack.includes('perf')) categoryId = 'release'
    else if (haystack.includes('system') || haystack.includes('demo') || haystack.includes('editor')) categoryId = 'system'
    return STARTER_TOOL_CATALOG.categories.find((category) => category.id === categoryId)?.id || null
  }

  const categoryName = command.category?.trim().toLowerCase() || ''
  const tags = (command.tags || []).map((tag) => tag.trim().toLowerCase())
  return catalog.categories.find((category) => (
    !isReservedToolCategoryId(category.id)
    && (
      category.id === categoryName
      || tags.includes(category.id)
      || tags.includes(`category:${category.id}`)
    )
  ))?.id || null
}

export function commandSupportsStage(
  command: { tags?: string[]; category?: string; name: string },
  stageId: ToolStageId,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
) {
  if (stageId === catalog.defaultPreferences.stageId) return true
  const tags = (command.tags || []).map((tag) => tag.trim().toLowerCase())
  if (tags.includes(stageId) || tags.includes(`stage:${stageId}`)) return true
  if (catalog !== STARTER_TOOL_CATALOG) return false

  const haystack = `${command.category || ''} ${(command.tags || []).join(' ')} ${command.name}`.toLowerCase()

  if (stageId === 'art') return /(asset|material|texture|rename|editor)/.test(haystack)
  if (stageId === 'ta') return /(asset|material|texture|blueprint|perf|demo|task)/.test(haystack)
  if (stageId === 'level') return /(level|blueprint|asset|editor)/.test(haystack)
  if (stageId === 'release') return /(release|gate|perf|asset|rename|system)/.test(haystack)
  return true
}

function cloneDefaultToolPreferences(catalog: ToolCatalogV1): ToolPreferenceState {
  return {
    ...catalog.defaultPreferences,
    favorites: [...catalog.defaultPreferences.favorites],
    openTabs: [...catalog.defaultPreferences.openTabs],
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

export function normalizeToolPreferences(
  value: unknown,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
): ToolPreferenceState {
  const defaults = cloneDefaultToolPreferences(catalog)
  if (!isRecord(value)) {
    return defaults
  }

  const requestedProject = catalog.projects.find((project) => project.id === value.projectId)
  const project = requestedProject
    || catalog.projects.find((item) => item.id === defaults.projectId)
    || catalog.projects[0]
  const requestedStageId = project.stages.find((stageId) => stageId === value.stageId)
  const stageId = requestedStageId
    ? requestedStageId
    : project.stages.includes(defaults.stageId)
      ? defaults.stageId
      : project.stages[0]
  const categoryId = catalog.categories.find((category) => category.id === value.categoryId)?.id
    || defaults.categoryId

  return {
    projectId: project.id,
    stageId,
    categoryId,
    favorites: normalizeStringList(value.favorites, defaults.favorites, MAX_FAVORITE_COMMANDS),
    openTabs: normalizeStringList(value.openTabs, defaults.openTabs, MAX_OPEN_TABS),
  }
}

export function toolPreferencesStorageKey(storageNamespace?: string) {
  return namespacedStorageKey(TOOL_PREFERENCES_STORAGE_KEY, storageNamespace)
}

export function loadToolPreferencesState(
  storageNamespace?: string | null,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
): StorageLoadResult<ToolPreferenceState> {
  if (storageNamespace === null) {
    return { value: cloneDefaultToolPreferences(catalog), needsRewrite: false, source: 'missing' }
  }
  try {
    const stored = globalThis.localStorage?.getItem(toolPreferencesStorageKey(storageNamespace))
    if (!stored) {
      return { value: cloneDefaultToolPreferences(catalog), needsRewrite: false, source: 'missing' }
    }

    const parsed: unknown = JSON.parse(stored)
    if (isRecord(parsed) && parsed.schemaVersion === TOOL_PREFERENCES_SCHEMA_VERSION) {
      if (!isRecord(parsed.data)) {
        return {
          value: cloneDefaultToolPreferences(catalog),
          needsRewrite: true,
          source: 'invalid',
        }
      }
      const value = normalizeToolPreferences(parsed.data, catalog)
      return {
        value,
        needsRewrite: JSON.stringify(value) !== JSON.stringify(parsed.data),
        source: 'current',
      }
    }

    if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')) {
      return {
        value: cloneDefaultToolPreferences(catalog),
        needsRewrite: false,
        source: 'unsupported',
      }
    }
    if (isRecord(parsed)) {
      return {
        value: normalizeToolPreferences(parsed, catalog),
        needsRewrite: true,
        source: 'legacy',
      }
    }
    return { value: cloneDefaultToolPreferences(catalog), needsRewrite: true, source: 'invalid' }
  } catch {
    return { value: cloneDefaultToolPreferences(catalog), needsRewrite: true, source: 'invalid' }
  }
}

export function loadToolPreferences(
  storageNamespace?: string | null,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
): ToolPreferenceState {
  return loadToolPreferencesState(storageNamespace, catalog).value
}

export function saveToolPreferences(
  preferences: ToolPreferenceState,
  storageNamespace?: string | null,
  catalog: ToolCatalogV1 = STARTER_TOOL_CATALOG,
) {
  if (storageNamespace === null) {
    return
  }
  try {
    globalThis.localStorage?.setItem(
      toolPreferencesStorageKey(storageNamespace),
      JSON.stringify(storedEnvelope(
        TOOL_PREFERENCES_SCHEMA_VERSION,
        normalizeToolPreferences(preferences, catalog),
      )),
    )
  } catch {
    // Embedded browser localStorage can be unavailable depending on context.
  }
}

export function clearToolPreferences(storageNamespace?: string | null) {
  if (storageNamespace === null) {
    return
  }
  try {
    globalThis.localStorage?.removeItem(toolPreferencesStorageKey(storageNamespace))
  } catch {
    // Embedded browser localStorage can be unavailable depending on context.
  }
}
