import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_CATALOG_PROJECTS,
  STARTER_TOOL_CATALOG,
  ToolCatalogDecodeError,
  decodeToolCatalogV1,
  toolCategoryIcon,
} from './tool-catalog'

const DOCUMENTATION_CATALOG_PATH = '../../docs/examples/tool-catalog.v1.json'
const documentationCatalog = import.meta.glob(
  '../../docs/examples/tool-catalog.v1.json',
  { eager: true, import: 'default' },
)[DOCUMENTATION_CATALOG_PATH]

function customCatalog() {
  return {
    schemaVersion: 1,
    projects: [
      {
        id: 'project-custom',
        name: 'Custom Project',
        description: 'Project catalog fixture',
        stages: ['stage-custom'],
      },
    ],
    stages: [{ id: 'stage-custom', label: 'Custom Stage' }],
    categories: [
      { id: 'all', label: 'All', icon: 'grid' },
      { id: 'favorites', label: 'Favorites', icon: 'star' },
      { id: 'recent', label: 'Recent', icon: 'recent' },
      { id: 'category-custom', label: 'Custom Category', icon: 'assets' },
    ],
    defaultPreferences: {
      projectId: 'project-custom',
      stageId: 'stage-custom',
      categoryId: 'category-custom',
      favorites: ['asset.scan'],
      openTabs: ['asset.scan'],
    },
  }
}

function expectDecodeCode(value: unknown, code: ToolCatalogDecodeError['code']) {
  try {
    decodeToolCatalogV1(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ToolCatalogDecodeError)
    expect((error as ToolCatalogDecodeError).code).toBe(code)
    return
  }
  throw new Error(`Expected catalog decoding to fail with ${code}.`)
}

describe('tool catalog schema v1', () => {
  it('decodes the bundled starter through the same closed schema', () => {
    expect(STARTER_TOOL_CATALOG.schemaVersion).toBe(1)
    expect(STARTER_TOOL_CATALOG.projects.map((project) => project.id)).toEqual([
      'aurora',
      'neon',
      'mobile',
    ])
    expect(Object.isFrozen(STARTER_TOOL_CATALOG)).toBe(true)
    expect(toolCategoryIcon(STARTER_TOOL_CATALOG.categories[0].icon)).toBe('▦')
  })

  it('accepts dynamic project, stage, and category identifiers', () => {
    const decoded = decodeToolCatalogV1(customCatalog())

    expect(decoded.defaultPreferences).toMatchObject({
      projectId: 'project-custom',
      stageId: 'stage-custom',
      categoryId: 'category-custom',
    })
    expect(decoded.projects[0].stages).toEqual(['stage-custom'])
    expect(Object.isFrozen(decoded.categories)).toBe(true)
  })

  it('keeps the documented schema-v1 example executable', () => {
    const decoded = decodeToolCatalogV1(documentationCatalog)

    expect(decoded.defaultPreferences).toMatchObject({
      projectId: 'studio',
      stageId: 'common',
      categoryId: 'all',
    })
  })

  it('rejects unsupported versions and unknown keys without partial decoding', () => {
    expectDecodeCode({ ...customCatalog(), schemaVersion: 2 }, 'catalog_unsupported_version')
    expectDecodeCode({ ...customCatalog(), executable: 'alert(1)' }, 'catalog_unknown_key')
    const nested = customCatalog()
    Object.assign(nested.projects[0], { path: 'C:/private/project' })
    expectDecodeCode(nested, 'catalog_unknown_key')
  })

  it('rejects empty, malformed, and duplicate identifiers', () => {
    const empty = customCatalog()
    empty.projects[0].id = ''
    expectDecodeCode(empty, 'catalog_invalid_id')

    const duplicate = customCatalog()
    duplicate.stages.push({ ...duplicate.stages[0] })
    expectDecodeCode(duplicate, 'catalog_duplicate_id')
  })

  it('rejects dangling project stages and invalid defaults', () => {
    const dangling = customCatalog()
    dangling.projects[0].stages = ['stage-missing']
    expectDecodeCode(dangling, 'catalog_invalid_reference')

    const invalidDefault = customCatalog()
    invalidDefault.defaultPreferences.categoryId = 'category-missing'
    expectDecodeCode(invalidDefault, 'catalog_invalid_default')
  })

  it('requires the reserved navigation categories', () => {
    const value = customCatalog()
    value.categories = value.categories.filter((category) => category.id !== 'recent')
    expectDecodeCode(value, 'catalog_invalid_reference')
  })

  it('enforces collection, string, default-list, and icon bounds', () => {
    const tooManyProjects = customCatalog()
    tooManyProjects.projects = Array.from({ length: MAX_TOOL_CATALOG_PROJECTS + 1 }, (_, index) => ({
      ...tooManyProjects.projects[0],
      id: `project-${index}`,
    }))
    expectDecodeCode(tooManyProjects, 'catalog_resource_limit')

    const longLabel = customCatalog()
    longLabel.stages[0].label = 'x'.repeat(81)
    expectDecodeCode(longLabel, 'catalog_resource_limit')

    const duplicateFavorite = customCatalog()
    duplicateFavorite.defaultPreferences.favorites = ['asset.scan', 'asset.scan']
    expectDecodeCode(duplicateFavorite, 'catalog_invalid_default')

    const markupIcon = customCatalog()
    markupIcon.categories[3].icon = '<svg onload=alert(1)>'
    expectDecodeCode(markupIcon, 'catalog_invalid_shape')
  })
})
