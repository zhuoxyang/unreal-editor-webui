import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useRecentExecutions } from './hooks/useRecentExecutions'
import { useToolPreferences } from './hooks/useToolPreferences'
import {
  cloneExecutionPayload,
  loadStoredRecentExecutionsState,
  MAX_RECENT_EXECUTIONS,
  RECENT_EXECUTIONS_SCHEMA_VERSION,
  RECENT_EXECUTIONS_STORAGE_KEY,
  recentExecutionsStorageKey,
  saveStoredRecentExecutions,
  type RecentExecution,
} from './recent-executions'
import {
  DEFAULT_TOOL_PREFERENCES,
  loadToolPreferencesState,
  MAX_FAVORITE_COMMANDS,
  MAX_OPEN_TABS,
  normalizeToolPreferences,
  saveToolPreferences,
  TOOL_PREFERENCES_SCHEMA_VERSION,
  TOOL_PREFERENCES_STORAGE_KEY,
  toolPreferencesStorageKey,
  type ToolPreferenceState,
} from './tool-manifest'
import type { CommandMetadata } from './types/command'

const TEST_COMMAND: CommandMetadata = {
  metadataVersion: 1,
  name: 'asset.scan',
  description: 'Scan assets',
  permission: 'read',
  schema: { type: 'object', properties: {} },
}

function execution(index: number): RecentExecution {
  return {
    id: `execution-${index}`,
    command: `asset.command-${index}`,
    mode: index % 2 === 0 ? 'run' : 'task',
    payload: { nested: { value: index } },
    ranAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }
}

afterEach(() => {
  window.localStorage.clear()
})

describe('recent execution storage', () => {
  it('loads legacy values while removing invalid, duplicate, and excess entries', () => {
    const values: unknown[] = [
      execution(0),
      execution(0),
      { ...execution(1), payload: [] },
      ...Array.from({ length: MAX_RECENT_EXECUTIONS + 3 }, (_, index) => execution(index + 2)),
    ]
    window.localStorage.setItem(RECENT_EXECUTIONS_STORAGE_KEY, JSON.stringify(values))

    const loaded = loadStoredRecentExecutionsState()

    expect(loaded.source).toBe('legacy')
    expect(loaded.needsRewrite).toBe(true)
    expect(loaded.value).toHaveLength(MAX_RECENT_EXECUTIONS)
    expect(new Set(loaded.value.map((item) => item.id)).size).toBe(MAX_RECENT_EXECUTIONS)
    expect(loaded.value.some((item) => item.id === 'execution-1')).toBe(false)
  })

  it('writes and reloads the current versioned envelope', () => {
    saveStoredRecentExecutions([execution(0)])

    expect(JSON.parse(window.localStorage.getItem(RECENT_EXECUTIONS_STORAGE_KEY) || '')).toEqual({
      schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION,
      data: [execution(0)],
    })
    expect(loadStoredRecentExecutionsState()).toMatchObject({
      source: 'current',
      needsRewrite: false,
      value: [execution(0)],
    })
  })

  it('does not migrate global history into a project namespace', () => {
    saveStoredRecentExecutions([execution(0)])
    expect(loadStoredRecentExecutionsState('project-a')).toMatchObject({
      source: 'missing',
      value: [],
    })
    expect(window.localStorage.getItem(recentExecutionsStorageKey('project-a'))).toBeNull()
  })

  it('distinguishes malformed current data from a future schema', () => {
    window.localStorage.setItem(
      RECENT_EXECUTIONS_STORAGE_KEY,
      JSON.stringify({ schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION, data: {} }),
    )
    expect(loadStoredRecentExecutionsState()).toMatchObject({
      source: 'invalid',
      needsRewrite: true,
      value: [],
    })

    window.localStorage.setItem(
      RECENT_EXECUTIONS_STORAGE_KEY,
      JSON.stringify({ schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION + 1, data: [execution(0)] }),
    )
    expect(loadStoredRecentExecutionsState()).toMatchObject({
      source: 'unsupported',
      needsRewrite: false,
      value: [],
    })

    window.localStorage.setItem(
      RECENT_EXECUTIONS_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 'future', data: [execution(0)] }),
    )
    expect(loadStoredRecentExecutionsState().source).toBe('unsupported')
  })

  it('fails safely when a payload cannot produce a JSON object', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(cloneExecutionPayload(circular)).toEqual({})
    expect(cloneExecutionPayload({ toJSON: () => null })).toEqual({})
  })
})

describe('tool preference storage', () => {
  it('normalizes project compatibility, list contents, duplicates, and limits', () => {
    const normalized = normalizeToolPreferences({
      projectId: 'neon',
      stageId: 'level',
      categoryId: 'unknown',
      favorites: [
        ' asset.scan ',
        'asset.scan',
        12,
        ...Array.from({ length: MAX_FAVORITE_COMMANDS + 2 }, (_, index) => `favorite-${index}`),
      ],
      openTabs: [
        '',
        'asset.scan',
        'asset.scan',
        ...Array.from({ length: MAX_OPEN_TABS + 2 }, (_, index) => `tab-${index}`),
      ],
    })

    expect(normalized.projectId).toBe('neon')
    expect(normalized.stageId).toBe('common')
    expect(normalized.categoryId).toBe(DEFAULT_TOOL_PREFERENCES.categoryId)
    expect(normalized.favorites).toHaveLength(MAX_FAVORITE_COMMANDS)
    expect(normalized.favorites[0]).toBe('asset.scan')
    expect(new Set(normalized.favorites).size).toBe(MAX_FAVORITE_COMMANDS)
    expect(normalized.openTabs).toHaveLength(MAX_OPEN_TABS)
    expect(new Set(normalized.openTabs).size).toBe(MAX_OPEN_TABS)
  })

  it('migrates legacy preferences and writes the current versioned envelope', () => {
    const legacy: ToolPreferenceState = {
      projectId: 'neon',
      stageId: 'art',
      categoryId: 'favorites',
      favorites: ['asset.scan'],
      openTabs: ['asset.rename'],
    }
    window.localStorage.setItem(TOOL_PREFERENCES_STORAGE_KEY, JSON.stringify(legacy))

    expect(loadToolPreferencesState()).toMatchObject({
      source: 'legacy',
      needsRewrite: true,
      value: legacy,
    })

    saveToolPreferences(legacy)
    expect(JSON.parse(window.localStorage.getItem(TOOL_PREFERENCES_STORAGE_KEY) || '')).toEqual({
      schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION,
      data: legacy,
    })
  })

  it('returns independent defaults and distinguishes malformed from future data', () => {
    const first = loadToolPreferencesState()
    const second = loadToolPreferencesState()
    first.value.favorites.push('mutated')

    expect(second.value.favorites).not.toContain('mutated')

    window.localStorage.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION, data: [] }),
    )
    expect(loadToolPreferencesState()).toMatchObject({
      source: 'invalid',
      needsRewrite: true,
    })

    window.localStorage.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION + 1, data: {} }),
    )
    expect(loadToolPreferencesState()).toMatchObject({
      source: 'unsupported',
      needsRewrite: false,
    })

    window.localStorage.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 'future', data: {} }),
    )
    expect(loadToolPreferencesState().source).toBe('unsupported')
  })

  it('does not migrate global preferences into a project namespace', () => {
    saveToolPreferences({
      ...DEFAULT_TOOL_PREFERENCES,
      favorites: ['global.favorite'],
      openTabs: [],
    })
    expect(loadToolPreferencesState('project-a').value.favorites).not.toContain('global.favorite')
    expect(window.localStorage.getItem(toolPreferencesStorageKey('project-a'))).toBeNull()
  })
})

describe('persistence hooks', () => {
  it('keeps unresolved state in memory and loads a verified namespace without leaking it', async () => {
    saveStoredRecentExecutions([execution(0)], 'project-a')
    const storedRecent = window.localStorage.getItem(recentExecutionsStorageKey('project-a'))
    const recent = renderHook(
      ({ storageNamespace }: { storageNamespace: string | null }) => useRecentExecutions(storageNamespace),
      { initialProps: { storageNamespace: null as string | null } },
    )

    act(() => recent.result.current.recordRecentExecution(TEST_COMMAND, { path: '/Unsaved' }, 'run'))
    expect(recent.result.current.recentExecutions[0].payload).toEqual({ path: '/Unsaved' })
    expect(window.localStorage.getItem(recentExecutionsStorageKey('project-a'))).toBe(storedRecent)

    recent.rerender({ storageNamespace: 'project-a' })
    await waitFor(() => expect(recent.result.current.recentExecutions).toEqual([execution(0)]))
    expect(window.localStorage.getItem(recentExecutionsStorageKey('project-a'))).toBe(storedRecent)

    const persistedPreferences: ToolPreferenceState = {
      projectId: 'neon',
      stageId: 'art',
      categoryId: 'favorites',
      favorites: ['persisted.favorite'],
      openTabs: ['persisted.tab'],
    }
    saveToolPreferences(persistedPreferences, 'project-a')
    const storedPreferences = window.localStorage.getItem(toolPreferencesStorageKey('project-a'))
    const preferences = renderHook(
      ({ storageNamespace }: { storageNamespace: string | null }) => useToolPreferences(storageNamespace),
      { initialProps: { storageNamespace: null as string | null } },
    )
    act(() => preferences.result.current.toggleFavoriteCommand('memory.only'))

    preferences.rerender({ storageNamespace: 'project-a' })
    await waitFor(() => expect(preferences.result.current.favoriteCommands).toEqual(['persisted.favorite']))
    expect(window.localStorage.getItem(toolPreferencesStorageKey('project-a'))).toBe(storedPreferences)
  })

  it('migrates legacy values after mounting', async () => {
    window.localStorage.setItem(RECENT_EXECUTIONS_STORAGE_KEY, JSON.stringify([execution(0)]))
    renderHook(() => useRecentExecutions())

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(RECENT_EXECUTIONS_STORAGE_KEY) || '')).toMatchObject({
        schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION,
      })
    })

    window.localStorage.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_TOOL_PREFERENCES,
        favorites: ['asset.scan'],
      }),
    )
    renderHook(() => useToolPreferences())

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(TOOL_PREFERENCES_STORAGE_KEY) || '')).toMatchObject({
        schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION,
      })
    })
  })

  it('does not create storage entries for clean empty initial state', () => {
    renderHook(() => useRecentExecutions())
    renderHook(() => useToolPreferences())

    expect(window.localStorage.getItem(RECENT_EXECUTIONS_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(TOOL_PREFERENCES_STORAGE_KEY)).toBeNull()
  })

  it('does not overwrite future schemas merely by mounting', () => {
    const futureRecent = JSON.stringify({
      schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION + 1,
      data: [execution(0)],
    })
    const futurePreferences = JSON.stringify({
      schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION + 1,
      data: DEFAULT_TOOL_PREFERENCES,
    })
    window.localStorage.setItem(RECENT_EXECUTIONS_STORAGE_KEY, futureRecent)
    window.localStorage.setItem(TOOL_PREFERENCES_STORAGE_KEY, futurePreferences)

    renderHook(() => useRecentExecutions())
    renderHook(() => useToolPreferences())

    expect(window.localStorage.getItem(RECENT_EXECUTIONS_STORAGE_KEY)).toBe(futureRecent)
    expect(window.localStorage.getItem(TOOL_PREFERENCES_STORAGE_KEY)).toBe(futurePreferences)
  })

  it('replaces a future schema only after an explicit user change', () => {
    window.localStorage.setItem(
      RECENT_EXECUTIONS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION + 1,
        data: [execution(0)],
      }),
    )
    const recent = renderHook(() => useRecentExecutions())

    act(() => {
      recent.result.current.recordRecentExecution(TEST_COMMAND, { path: '/Game' }, 'run')
    })

    expect(JSON.parse(window.localStorage.getItem(RECENT_EXECUTIONS_STORAGE_KEY) || '')).toMatchObject({
      schemaVersion: RECENT_EXECUTIONS_SCHEMA_VERSION,
    })

    window.localStorage.setItem(
      TOOL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION + 1,
        data: DEFAULT_TOOL_PREFERENCES,
      }),
    )
    const preferences = renderHook(() => useToolPreferences())

    act(() => {
      preferences.result.current.toggleFavoriteCommand('asset.scan')
    })

    expect(JSON.parse(window.localStorage.getItem(TOOL_PREFERENCES_STORAGE_KEY) || '')).toMatchObject({
      schemaVersion: TOOL_PREFERENCES_SCHEMA_VERSION,
    })
  })

  it('takes a deep payload snapshot when recording an execution', () => {
    const payload = { nested: { value: 1 } }
    const { result } = renderHook(() => useRecentExecutions())

    act(() => {
      result.current.recordRecentExecution(TEST_COMMAND, payload, 'run')
    })
    payload.nested.value = 2

    expect(result.current.recentExecutions[0].payload).toEqual({
      nested: { value: 1 },
    })
  })
})
