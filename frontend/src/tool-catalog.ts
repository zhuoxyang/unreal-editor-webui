import starterCatalogJson from './tool-catalog.json'

type BrandedCatalogId<Kind extends string> = string & {
  readonly __toolCatalogId?: Kind
}

export type ToolProjectId = BrandedCatalogId<'project'>
export type ToolStageId = BrandedCatalogId<'stage'>
export type ToolCategoryId = BrandedCatalogId<'category'>

export const TOOL_CATEGORY_ICON_TOKENS = [
  'grid',
  'star',
  'recent',
  'assets',
  'materials',
  'level',
  'release',
  'system',
] as const

export type ToolCategoryIconToken = (typeof TOOL_CATEGORY_ICON_TOKENS)[number]

export type ToolProject = {
  readonly id: ToolProjectId
  readonly name: string
  readonly description: string
  readonly stages: readonly ToolStageId[]
}

export type ToolStage = {
  readonly id: ToolStageId
  readonly label: string
}

export type ToolCategory = {
  readonly id: ToolCategoryId
  readonly label: string
  readonly icon: ToolCategoryIconToken
}

export type ToolCatalogDefaults = {
  readonly projectId: ToolProjectId
  readonly stageId: ToolStageId
  readonly categoryId: ToolCategoryId
  readonly favorites: readonly string[]
  readonly openTabs: readonly string[]
}

export type ToolCatalogV1 = {
  readonly schemaVersion: 1
  readonly projects: readonly ToolProject[]
  readonly stages: readonly ToolStage[]
  readonly categories: readonly ToolCategory[]
  readonly defaultPreferences: ToolCatalogDefaults
}

export const MAX_TOOL_CATALOG_PROJECTS = 64
export const MAX_TOOL_CATALOG_STAGES = 64
export const MAX_TOOL_CATALOG_CATEGORIES = 64
export const MAX_PROJECT_STAGES = 32
export const MAX_FAVORITE_COMMANDS = 12
export const MAX_OPEN_TABS = 8
export const MAX_TOOL_CATALOG_ID_LENGTH = 64
export const MAX_TOOL_CATALOG_LABEL_LENGTH = 80
export const MAX_TOOL_CATALOG_DESCRIPTION_LENGTH = 256
export const MAX_TOOL_COMMAND_NAME_LENGTH = 256

const CATALOG_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
const ICON_TOKENS = new Set<string>(TOOL_CATEGORY_ICON_TOKENS)
const RESERVED_CATEGORY_IDS = ['all', 'favorites', 'recent'] as const

export type ToolCatalogDecodeErrorCode =
  | 'catalog_invalid_shape'
  | 'catalog_unsupported_version'
  | 'catalog_unknown_key'
  | 'catalog_resource_limit'
  | 'catalog_invalid_id'
  | 'catalog_duplicate_id'
  | 'catalog_invalid_reference'
  | 'catalog_invalid_default'

export class ToolCatalogDecodeError extends Error {
  readonly code: ToolCatalogDecodeErrorCode

  constructor(code: ToolCatalogDecodeErrorCode, message: string) {
    super(message)
    this.name = 'ToolCatalogDecodeError'
    this.code = code
  }
}

function fail(code: ToolCatalogDecodeErrorCode, message: string): never {
  throw new ToolCatalogDecodeError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requireAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const allowedKeys = new Set(allowed)
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    fail('catalog_unknown_key', `${path} contains unknown key "${unknownKey}".`)
  }
}

function requireArray(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value)) {
    fail('catalog_invalid_shape', `${path} must be an array.`)
  }
  if (value.length < minimum || value.length > maximum) {
    fail('catalog_resource_limit', `${path} must contain from ${minimum} to ${maximum} items.`)
  }
  return value
}

function requireDisplayString(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
) {
  if (typeof value !== 'string' || value !== value.trim()) {
    fail('catalog_invalid_shape', `${path} must be a trimmed string.`)
  }
  if ((!allowEmpty && value.length === 0) || value.length > maximum) {
    fail('catalog_resource_limit', `${path} has an unsupported length.`)
  }
  return value
}

function requireId<Id extends string>(value: unknown, path: string): Id {
  if (typeof value !== 'string' || !CATALOG_ID_PATTERN.test(value)) {
    fail(
      'catalog_invalid_id',
      `${path} must be a lowercase catalog id no longer than ${MAX_TOOL_CATALOG_ID_LENGTH} characters.`,
    )
  }
  return value as Id
}

function requireUniqueIds<Id extends string>(items: readonly { id: Id }[], path: string) {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) {
      fail('catalog_duplicate_id', `${path} contains duplicate id "${item.id}".`)
    }
    ids.add(item.id)
  }
}

function decodeProject(value: unknown, index: number): ToolProject {
  const path = `projects[${index}]`
  if (!isRecord(value)) {
    fail('catalog_invalid_shape', `${path} must be an object.`)
  }
  requireAllowedKeys(value, ['id', 'name', 'description', 'stages'], path)
  if (!hasOwn(value, 'id') || !hasOwn(value, 'name') || !hasOwn(value, 'stages')) {
    fail('catalog_invalid_shape', `${path} is missing a required field.`)
  }

  const stages = requireArray(value.stages, `${path}.stages`, 1, MAX_PROJECT_STAGES)
    .map((stageId, stageIndex) => requireId<ToolStageId>(stageId, `${path}.stages[${stageIndex}]`))
  if (new Set(stages).size !== stages.length) {
    fail('catalog_duplicate_id', `${path}.stages must contain unique stage ids.`)
  }

  return Object.freeze({
    id: requireId<ToolProjectId>(value.id, `${path}.id`),
    name: requireDisplayString(value.name, `${path}.name`, MAX_TOOL_CATALOG_LABEL_LENGTH),
    description: value.description === undefined
      ? ''
      : requireDisplayString(
          value.description,
          `${path}.description`,
          MAX_TOOL_CATALOG_DESCRIPTION_LENGTH,
          true,
        ),
    stages: Object.freeze(stages),
  })
}

function decodeStage(value: unknown, index: number): ToolStage {
  const path = `stages[${index}]`
  if (!isRecord(value)) {
    fail('catalog_invalid_shape', `${path} must be an object.`)
  }
  requireAllowedKeys(value, ['id', 'label'], path)
  if (!hasOwn(value, 'id') || !hasOwn(value, 'label')) {
    fail('catalog_invalid_shape', `${path} is missing a required field.`)
  }
  return Object.freeze({
    id: requireId<ToolStageId>(value.id, `${path}.id`),
    label: requireDisplayString(value.label, `${path}.label`, MAX_TOOL_CATALOG_LABEL_LENGTH),
  })
}

function decodeCategory(value: unknown, index: number): ToolCategory {
  const path = `categories[${index}]`
  if (!isRecord(value)) {
    fail('catalog_invalid_shape', `${path} must be an object.`)
  }
  requireAllowedKeys(value, ['id', 'label', 'icon'], path)
  if (!hasOwn(value, 'id') || !hasOwn(value, 'label') || !hasOwn(value, 'icon')) {
    fail('catalog_invalid_shape', `${path} is missing a required field.`)
  }
  if (typeof value.icon !== 'string' || !ICON_TOKENS.has(value.icon)) {
    fail('catalog_invalid_shape', `${path}.icon must be a supported icon token.`)
  }
  return Object.freeze({
    id: requireId<ToolCategoryId>(value.id, `${path}.id`),
    label: requireDisplayString(value.label, `${path}.label`, MAX_TOOL_CATALOG_LABEL_LENGTH),
    icon: value.icon as ToolCategoryIconToken,
  })
}

function decodeCommandNames(value: unknown, path: string, maximum: number): readonly string[] {
  const values = requireArray(value, path, 0, maximum)
  const result: string[] = []
  const names = new Set<string>()
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index]
    if (
      typeof name !== 'string'
      || name !== name.trim()
      || name.length === 0
      || name.length > MAX_TOOL_COMMAND_NAME_LENGTH
    ) {
      fail('catalog_invalid_default', `${path}[${index}] must be a bounded, trimmed command name.`)
    }
    if (names.has(name)) {
      fail('catalog_invalid_default', `${path} must contain unique command names.`)
    }
    names.add(name)
    result.push(name)
  }
  return Object.freeze(result)
}

function decodeDefaults(value: unknown): ToolCatalogDefaults {
  const path = 'defaultPreferences'
  if (!isRecord(value)) {
    fail('catalog_invalid_shape', `${path} must be an object.`)
  }
  requireAllowedKeys(value, ['projectId', 'stageId', 'categoryId', 'favorites', 'openTabs'], path)
  for (const key of ['projectId', 'stageId', 'categoryId', 'favorites', 'openTabs']) {
    if (!hasOwn(value, key)) {
      fail('catalog_invalid_shape', `${path} is missing required field "${key}".`)
    }
  }
  return Object.freeze({
    projectId: requireId<ToolProjectId>(value.projectId, `${path}.projectId`),
    stageId: requireId<ToolStageId>(value.stageId, `${path}.stageId`),
    categoryId: requireId<ToolCategoryId>(value.categoryId, `${path}.categoryId`),
    favorites: decodeCommandNames(value.favorites, `${path}.favorites`, MAX_FAVORITE_COMMANDS),
    openTabs: decodeCommandNames(value.openTabs, `${path}.openTabs`, MAX_OPEN_TABS),
  })
}

export function decodeToolCatalogV1(value: unknown): ToolCatalogV1 {
  if (!isRecord(value)) {
    fail('catalog_invalid_shape', 'catalog must be an object.')
  }
  requireAllowedKeys(
    value,
    ['schemaVersion', 'projects', 'stages', 'categories', 'defaultPreferences'],
    'catalog',
  )
  if (!hasOwn(value, 'schemaVersion')) {
    fail('catalog_invalid_shape', 'catalog is missing required field "schemaVersion".')
  }
  if (value.schemaVersion !== 1) {
    fail('catalog_unsupported_version', 'catalog requires schemaVersion 1.')
  }
  for (const key of ['projects', 'stages', 'categories', 'defaultPreferences']) {
    if (!hasOwn(value, key)) {
      fail('catalog_invalid_shape', `catalog is missing required field "${key}".`)
    }
  }

  const projects = requireArray(value.projects, 'projects', 1, MAX_TOOL_CATALOG_PROJECTS)
    .map(decodeProject)
  const stages = requireArray(value.stages, 'stages', 1, MAX_TOOL_CATALOG_STAGES)
    .map(decodeStage)
  const categories = requireArray(value.categories, 'categories', 3, MAX_TOOL_CATALOG_CATEGORIES)
    .map(decodeCategory)
  requireUniqueIds(projects, 'projects')
  requireUniqueIds(stages, 'stages')
  requireUniqueIds(categories, 'categories')

  const stageIds = new Set(stages.map((stage) => stage.id as string))
  for (const project of projects) {
    const missingStage = project.stages.find((stageId) => !stageIds.has(stageId))
    if (missingStage) {
      fail(
        'catalog_invalid_reference',
        `project "${project.id}" references missing stage "${missingStage}".`,
      )
    }
  }

  const categoryIds = new Set(categories.map((category) => category.id as string))
  for (const requiredCategoryId of RESERVED_CATEGORY_IDS) {
    if (!categoryIds.has(requiredCategoryId)) {
      fail(
        'catalog_invalid_reference',
        `catalog requires reserved category "${requiredCategoryId}".`,
      )
    }
  }

  const defaultPreferences = decodeDefaults(value.defaultPreferences)
  const defaultProject = projects.find((project) => project.id === defaultPreferences.projectId)
  if (!defaultProject) {
    fail('catalog_invalid_default', 'default project does not exist.')
  }
  if (!stageIds.has(defaultPreferences.stageId) || !defaultProject.stages.includes(defaultPreferences.stageId)) {
    fail('catalog_invalid_default', 'default stage does not exist or is not allowed by the default project.')
  }
  if (!categoryIds.has(defaultPreferences.categoryId)) {
    fail('catalog_invalid_default', 'default category does not exist.')
  }

  return Object.freeze({
    schemaVersion: 1,
    projects: Object.freeze(projects),
    stages: Object.freeze(stages),
    categories: Object.freeze(categories),
    defaultPreferences,
  })
}

export const STARTER_TOOL_CATALOG = decodeToolCatalogV1(starterCatalogJson)

const ICON_GLYPHS: Readonly<Record<ToolCategoryIconToken, string>> = Object.freeze({
  grid: '▦',
  star: '★',
  recent: '◷',
  assets: '◈',
  materials: '✦',
  level: '⎔',
  release: '✓',
  system: '⚙',
})

export function toolCategoryIcon(token: ToolCategoryIconToken) {
  return ICON_GLYPHS[token]
}

export function isReservedToolCategoryId(value: ToolCategoryId) {
  return RESERVED_CATEGORY_IDS.some((categoryId) => categoryId === value)
}
