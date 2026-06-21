import type { ReactNode } from 'react'

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

export const TOOL_PROJECTS: ToolProject[] = [
  {
    id: 'aurora',
    name: 'Project Aurora',
    description: '高品质主机/PC 项目',
    stages: ['common', 'art', 'ta', 'level', 'release'],
  },
  {
    id: 'neon',
    name: 'Project Neon',
    description: '风格化动作项目',
    stages: ['common', 'art', 'ta', 'release'],
  },
  {
    id: 'mobile',
    name: 'Project Mobile',
    description: '移动端性能优先项目',
    stages: ['common', 'ta', 'level', 'release'],
  },
]

export const TOOL_STAGES: ToolStage[] = [
  { id: 'common', label: '我的常用' },
  { id: 'art', label: '创意设计' },
  { id: 'ta', label: 'TA 工程' },
  { id: 'level', label: '关卡制作' },
  { id: 'release', label: '项目管理' },
]

export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: 'all', label: '全部工具', icon: '▦' },
  { id: 'favorites', label: '收藏', icon: '★' },
  { id: 'recent', label: '最近', icon: '◷' },
  { id: 'assets', label: '资产', icon: '◈' },
  { id: 'materials', label: '材质', icon: '✦' },
  { id: 'level', label: '关卡', icon: '⎔' },
  { id: 'release', label: '发布', icon: '✓' },
  { id: 'system', label: '系统', icon: '⚙' },
]

export const DEFAULT_TOOL_PREFERENCES: ToolPreferenceState = {
  projectId: 'aurora',
  stageId: 'common',
  categoryId: 'all',
  favorites: ['asset.listByPath', 'asset.validateNaming', 'editor.selectedAssets'],
  openTabs: [],
}

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
