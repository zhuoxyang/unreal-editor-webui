import { describe, expect, it } from 'vitest'
import {
  commandCategoryId,
  commandSupportsStage,
  DEFAULT_TOOL_PREFERENCES,
  TOOL_CATEGORIES,
  TOOL_PROJECTS,
  TOOL_STAGES,
  type ToolStageId,
} from './tool-manifest'

describe('tool manifest catalog', () => {
  it('keeps catalog identifiers and default list entries unique and internally consistent', () => {
    const projectIds = TOOL_PROJECTS.map((project) => project.id)
    const stageIds = TOOL_STAGES.map((stage) => stage.id)
    const categoryIds = TOOL_CATEGORIES.map((category) => category.id)

    expect(new Set(projectIds).size).toBe(projectIds.length)
    expect(new Set(stageIds).size).toBe(stageIds.length)
    expect(new Set(categoryIds).size).toBe(categoryIds.length)
    expect(TOOL_PROJECTS.filter((project) => project.id === DEFAULT_TOOL_PREFERENCES.projectId)).toHaveLength(1)
    expect(TOOL_STAGES.filter((stage) => stage.id === DEFAULT_TOOL_PREFERENCES.stageId)).toHaveLength(1)
    expect(TOOL_CATEGORIES.filter((category) => category.id === DEFAULT_TOOL_PREFERENCES.categoryId)).toHaveLength(1)

    for (const project of TOOL_PROJECTS) {
      expect(new Set(project.stages).size).toBe(project.stages.length)
      expect(project.stages.every((stageId) => stageIds.includes(stageId))).toBe(true)
    }

    const defaultProject = TOOL_PROJECTS.find((project) => project.id === DEFAULT_TOOL_PREFERENCES.projectId)
    expect(defaultProject?.stages).toContain(DEFAULT_TOOL_PREFERENCES.stageId)
    expect(new Set(DEFAULT_TOOL_PREFERENCES.favorites).size).toBe(DEFAULT_TOOL_PREFERENCES.favorites.length)
    expect(new Set(DEFAULT_TOOL_PREFERENCES.openTabs).size).toBe(DEFAULT_TOOL_PREFERENCES.openTabs.length)
  })
})

describe('command category inference', () => {
  it.each([
    {
      source: 'an explicit category',
      command: { name: 'tools.inspect', category: 'Material Tools' },
      expected: 'materials',
    },
    {
      source: 'a tag',
      command: { name: 'tools.inspect', tags: ['TEXTURE'] },
      expected: 'materials',
    },
    {
      source: 'the command name',
      command: { name: 'world.compileBlueprint' },
      expected: 'level',
    },
    {
      source: 'a performance tag',
      command: { name: 'tools.inspect', tags: ['performance'] },
      expected: 'release',
    },
    {
      source: 'an editor category',
      command: { name: 'tools.inspect', category: 'EDITOR' },
      expected: 'system',
    },
  ])('classifies from $source without case sensitivity', ({ command, expected }) => {
    expect(commandCategoryId(command)).toBe(expected)
  })

  it('applies the documented keyword priority across category, tags, and name', () => {
    expect(
      commandCategoryId({
        name: 'system.inspect',
        category: 'material',
        tags: ['level', 'release'],
      }),
    ).toBe('materials')
  })

  it.each([
    { name: '' },
    { name: '   ', category: '', tags: [] },
    { name: 'tools.inspect', category: 'miscellaneous', tags: ['unknown'] },
  ])('falls back to assets for an unknown or empty command %#', (command) => {
    expect(commandCategoryId(command)).toBe('assets')
  })

  it('ignores metadata fields that are outside the inference contract', () => {
    const command = {
      name: 'tools.inspect',
      permission: 'destructive',
      resultType: 'release.material',
    }

    expect(commandCategoryId(command)).toBe('assets')
    expect(commandSupportsStage(command, 'release')).toBe(false)
  })
})

describe('command stage inference', () => {
  it.each([
    { stageId: 'common', command: { name: '' }, expected: true },
    { stageId: 'art', command: { name: 'tools.inspect', category: 'material' }, expected: true },
    { stageId: 'art', command: { name: 'release.gate' }, expected: false },
    { stageId: 'ta', command: { name: 'tools.inspect', tags: ['TASK'] }, expected: true },
    { stageId: 'ta', command: { name: 'level.open' }, expected: false },
    { stageId: 'level', command: { name: 'world.compileBlueprint' }, expected: true },
    { stageId: 'level', command: { name: 'release.gate' }, expected: false },
    { stageId: 'release', command: { name: 'tools.inspect', tags: ['performance'] }, expected: true },
    { stageId: 'release', command: { name: 'texture.inspect' }, expected: false },
  ] satisfies Array<{
    stageId: ToolStageId
    command: { name: string; category?: string; tags?: string[] }
    expected: boolean
  }>)('returns $expected for $stageId and $command.name', ({ stageId, command, expected }) => {
    expect(commandSupportsStage(command, stageId)).toBe(expected)
  })

  it('uses the permissive fallback only for an unknown runtime stage', () => {
    expect(commandSupportsStage({ name: 'tools.inspect' }, 'unknown' as ToolStageId)).toBe(true)
  })
})
