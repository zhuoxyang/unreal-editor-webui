import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RecentExecution } from '../recent-executions'
import type { ToolPreferenceState } from '../tool-manifest'
import type { CommandMetadata } from '../types/command'
import { decodeToolCatalogV1 } from '../tool-catalog'
import { useToolWorkspace } from './useToolWorkspace'

type WorkspaceOptions = Parameters<typeof useToolWorkspace>[0]
type WorkspaceOverrides = Omit<Partial<WorkspaceOptions>, 'toolPreferences'> & {
  toolPreferences?: Partial<ToolPreferenceState>
}

function command(
  name: string,
  description: string,
  permission: CommandMetadata['permission'],
  category: string,
  tags: string[],
  icon: string,
): CommandMetadata {
  return {
    metadataVersion: 1,
    name,
    description,
    permission,
    category,
    tags,
    icon,
    schema: { type: 'object', properties: {} },
  }
}

const COMMANDS: CommandMetadata[] = [
  command('asset.scan', 'Scan project content paths.', 'read', 'Assets', ['asset', 'audit'], 'AS'),
  command('material.compile', 'Compile shaders for the scene.', 'write', 'Materials', ['material', 'texture', 'art'], 'MA'),
  command('level.open', 'Open a Blueprint level.', 'destructive', 'Level', ['level', 'blueprint'], 'LV'),
  command('release.gate', 'Publish the performance gate.', 'write', 'Release', ['release', 'perf', 'gate'], 'RG'),
  command('system.ping', 'Check editor health.', 'read', 'System', ['system', 'diagnostic'], 'SY'),
  command('misc.convert', 'Convert neutral data.', 'destructive', 'Miscellaneous', ['utility'], 'MC'),
]

const BASE_PREFERENCES: ToolPreferenceState = {
  projectId: 'aurora',
  stageId: 'common',
  categoryId: 'all',
  favorites: [],
  openTabs: [],
}

function workspaceOptions(overrides: WorkspaceOverrides = {}): WorkspaceOptions {
  const { toolPreferences, ...rest } = overrides
  return {
    commands: COMMANDS,
    commandSearch: '',
    favoriteCommands: [],
    recentExecutions: [],
    selectedCommandName: null,
    toolPreferences: { ...BASE_PREFERENCES, ...toolPreferences },
    workspaceTabs: [],
    ...rest,
  }
}

function execution(commandName: string, index: number): RecentExecution {
  return {
    id: `execution-${index}`,
    command: commandName,
    mode: index % 2 === 0 ? 'run' : 'task',
    payload: { index },
    ranAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }
}

function commandNames(commands: CommandMetadata[]) {
  return commands.map((item) => item.name)
}

function stageIds(stages: ReturnType<typeof useToolWorkspace>['availableStages']) {
  return stages.map((stage) => stage.id)
}

describe('useToolWorkspace', () => {
  it('searches names, descriptions, categories, and tags case-insensitively', () => {
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      { initialProps: workspaceOptions({ commandSearch: '  ASSET.SCAN  ' }) },
    )

    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan'])

    for (const [query, expected] of [
      ['compile shaders', ['material.compile']],
      ['materials', ['material.compile']],
      ['DIAGNOSTIC', ['system.ping']],
      ['neutral DATA', ['misc.convert']],
      ['not present', []],
      ['   ', COMMANDS.map((item) => item.name)],
    ] as const) {
      rerender(workspaceOptions({ commandSearch: query }))
      expect(commandNames(result.current.filteredCommands), query).toEqual(expected)
    }
  })

  it('keeps every permission level available while applying inferred category filters', () => {
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      { initialProps: workspaceOptions() },
    )

    expect(result.current.filteredCommands.map((item) => item.permission).sort()).toEqual([
      'destructive',
      'destructive',
      'read',
      'read',
      'write',
      'write',
    ])

    for (const [categoryId, expected] of [
      ['assets', ['asset.scan', 'misc.convert']],
      ['materials', ['material.compile']],
      ['level', ['level.open']],
      ['release', ['release.gate']],
      ['system', ['system.ping']],
    ] as const) {
      rerender(workspaceOptions({ toolPreferences: { categoryId } }))
      expect(commandNames(result.current.filteredCommands), categoryId).toEqual(expected)
    }
  })

  it('derives project stages and applies each production-stage filter', () => {
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      {
        initialProps: workspaceOptions({
          toolPreferences: { projectId: 'aurora', stageId: 'art' },
        }),
      },
    )

    expect(stageIds(result.current.availableStages)).toEqual(['common', 'art', 'ta', 'level', 'release'])
    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'material.compile'])

    rerender(workspaceOptions({ toolPreferences: { projectId: 'neon', stageId: 'ta' } }))
    expect(stageIds(result.current.availableStages)).toEqual(['common', 'art', 'ta', 'release'])
    expect(commandNames(result.current.filteredCommands)).toEqual([
      'asset.scan',
      'material.compile',
      'level.open',
      'release.gate',
    ])

    rerender(workspaceOptions({ toolPreferences: { projectId: 'mobile', stageId: 'level' } }))
    expect(stageIds(result.current.availableStages)).toEqual(['common', 'ta', 'level', 'release'])
    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'level.open'])

    rerender(workspaceOptions({ toolPreferences: { projectId: 'aurora', stageId: 'release' } }))
    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'release.gate', 'system.ping'])

    rerender(workspaceOptions({
      toolPreferences: {
        projectId: 'removed-project' as ToolPreferenceState['projectId'],
        stageId: 'common',
      },
    }))
    expect(stageIds(result.current.availableStages)).toEqual(['common', 'art', 'ta', 'level', 'release'])
    expect(commandNames(result.current.filteredCommands)).toEqual(COMMANDS.map((item) => item.name))
  })

  it('keeps favorite order for shortcuts while filtering the catalog by favorites', () => {
    const favoriteCommands = ['release.gate', 'missing.command', 'asset.scan']
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      {
        initialProps: workspaceOptions({
          favoriteCommands,
          toolPreferences: { categoryId: 'favorites' },
        }),
      },
    )

    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'release.gate'])
    expect(commandNames(result.current.visibleFavoriteCommands)).toEqual(['release.gate', 'asset.scan'])
    expect([...result.current.favoriteCommandSet]).toEqual(favoriteCommands)

    rerender(workspaceOptions({
      commandSearch: 'publish',
      favoriteCommands,
      toolPreferences: { categoryId: 'favorites' },
    }))
    expect(commandNames(result.current.filteredCommands)).toEqual(['release.gate'])
    expect(commandNames(result.current.visibleFavoriteCommands)).toEqual(['release.gate', 'asset.scan'])

    rerender(workspaceOptions({
      favoriteCommands,
      toolPreferences: { categoryId: 'favorites', stageId: 'art' },
    }))
    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan'])
  })

  it('deduplicates, caps, and resolves recent command shortcuts independently of catalog order', () => {
    const recentExecutions = [
      execution('level.open', 0),
      execution('asset.scan', 1),
      execution('level.open', 2),
      execution('missing.command', 3),
      execution('system.ping', 4),
    ]
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      {
        initialProps: workspaceOptions({
          recentExecutions,
          toolPreferences: { categoryId: 'recent' },
        }),
      },
    )

    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'level.open', 'system.ping'])
    expect(commandNames(result.current.visibleRecentCommands)).toEqual(['level.open', 'asset.scan', 'system.ping'])

    rerender(workspaceOptions({
      recentExecutions,
      toolPreferences: { categoryId: 'recent', stageId: 'level' },
    }))
    expect(commandNames(result.current.filteredCommands)).toEqual(['asset.scan', 'level.open'])
    expect(commandNames(result.current.visibleRecentCommands)).toEqual(['level.open', 'asset.scan', 'system.ping'])

    const manyCommands = Array.from({ length: 7 }, (_, index) =>
      command(`asset.extra-${index}`, `Extra asset ${index}.`, 'read', 'Assets', ['asset'], `E${index}`),
    )
    rerender(workspaceOptions({
      commands: manyCommands,
      recentExecutions: manyCommands.map((item, index) => execution(item.name, index)),
    }))
    expect(commandNames(result.current.visibleRecentCommands)).toEqual(
      manyCommands.slice(0, 6).map((item) => item.name),
    )
  })

  it('removes stale workspace tabs and prepends a selected command only when needed', () => {
    const workspaceTabs = ['material.compile', 'missing.command', 'asset.scan']
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      {
        initialProps: workspaceOptions({
          selectedCommandName: 'release.gate',
          workspaceTabs,
        }),
      },
    )

    expect(result.current.workspaceCommandTabs).toEqual([
      { name: 'release.gate', icon: 'RG' },
      { name: 'material.compile', icon: 'MA' },
      { name: 'asset.scan', icon: 'AS' },
    ])

    rerender(workspaceOptions({ selectedCommandName: 'asset.scan', workspaceTabs }))
    expect(result.current.workspaceCommandTabs).toEqual([
      { name: 'material.compile', icon: 'MA' },
      { name: 'asset.scan', icon: 'AS' },
    ])

    rerender(workspaceOptions({
      selectedCommandName: 'removed.command',
      toolPreferences: { categoryId: 'materials' },
      workspaceTabs: ['asset.scan'],
    }))
    expect(result.current.selectedCommand?.name).toBe('material.compile')
    expect(result.current.workspaceCommandTabs).toEqual([
      { name: 'material.compile', icon: 'MA' },
      { name: 'asset.scan', icon: 'AS' },
    ])

    rerender(workspaceOptions({ commands: [], selectedCommandName: 'removed.command', workspaceTabs }))
    expect(result.current.workspaceCommandTabs).toEqual([])
  })

  it('preserves a valid selection and falls back when it is absent or invalidated', () => {
    const { result, rerender } = renderHook(
      (props: WorkspaceOptions) => useToolWorkspace(props),
      {
        initialProps: workspaceOptions({
          selectedCommandName: 'asset.scan',
          toolPreferences: { categoryId: 'materials' },
        }),
      },
    )

    expect(commandNames(result.current.filteredCommands)).toEqual(['material.compile'])
    expect(result.current.selectedCommand?.name).toBe('asset.scan')

    rerender(workspaceOptions({
      selectedCommandName: 'missing.command',
      toolPreferences: { categoryId: 'materials' },
    }))
    expect(result.current.selectedCommand?.name).toBe('material.compile')

    rerender(workspaceOptions({ commandSearch: 'not present', selectedCommandName: null }))
    expect(result.current.filteredCommands).toEqual([])
    expect(result.current.selectedCommand).toBeNull()

    rerender(workspaceOptions({
      commands: COMMANDS.filter((item) => item.name !== 'asset.scan'),
      selectedCommandName: 'asset.scan',
    }))
    expect(result.current.selectedCommand?.name).toBe('material.compile')

    rerender(workspaceOptions({ commandSearch: 'diagnostic', selectedCommandName: null }))
    expect(result.current.selectedCommand?.name).toBe('system.ping')
  })

  it('filters dynamic catalog categories and stages through exact metadata ids and tags', () => {
    const catalog = decodeToolCatalogV1({
      schemaVersion: 1,
      projects: [{
        id: 'project-custom',
        name: 'Custom',
        stages: ['stage-all', 'stage-custom'],
      }],
      stages: [
        { id: 'stage-all', label: 'All Stages' },
        { id: 'stage-custom', label: 'Custom Stage' },
      ],
      categories: [
        { id: 'all', label: 'All', icon: 'grid' },
        { id: 'favorites', label: 'Favorites', icon: 'star' },
        { id: 'recent', label: 'Recent', icon: 'recent' },
        { id: 'category-custom', label: 'Custom', icon: 'assets' },
      ],
      defaultPreferences: {
        projectId: 'project-custom',
        stageId: 'stage-all',
        categoryId: 'all',
        favorites: [],
        openTabs: [],
      },
    })
    const commands = [
      command('custom.category', 'Exact category.', 'read', 'category-custom', ['stage:stage-custom'], 'CC'),
      command('custom.tags', 'Tagged category.', 'read', 'Misc', ['category:category-custom', 'stage-custom'], 'CT'),
      command('custom.wrong-stage', 'Wrong stage.', 'read', 'category-custom', ['stage:other'], 'CW'),
      command('custom.wrong-category', 'Wrong category.', 'read', 'Other', ['stage-custom'], 'CO'),
    ]
    const { result } = renderHook(() => useToolWorkspace(workspaceOptions({
      catalog,
      commands,
      toolPreferences: {
        projectId: 'project-custom',
        stageId: 'stage-custom',
        categoryId: 'category-custom',
      },
    })))

    expect(stageIds(result.current.availableStages)).toEqual(['stage-all', 'stage-custom'])
    expect(commandNames(result.current.filteredCommands)).toEqual(['custom.category', 'custom.tags'])

    const defaultStage = renderHook(() => useToolWorkspace(workspaceOptions({
      catalog,
      commands,
      toolPreferences: {
        projectId: 'project-custom',
        stageId: 'stage-all',
        categoryId: 'all',
      },
    })))
    expect(commandNames(defaultStage.result.current.filteredCommands)).toEqual(
      commands.map((item) => item.name),
    )
  })
})
