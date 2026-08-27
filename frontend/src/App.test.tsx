import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { toolPreferencesStorageKey } from './tool-manifest'

function bridgeResponse(result: unknown) {
  return JSON.stringify({ id: null, ok: true, result })
}

function bridgeError(message: string) {
  return JSON.stringify({ id: null, ok: false, error: { code: 'test_error', message } })
}

function customToolCatalog() {
  return {
    schemaVersion: 1,
    projects: [{ id: 'project-custom', name: 'Custom Project', stages: ['stage-custom'] }],
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
      favorites: [],
      openTabs: [],
    },
  }
}

function installBridge(
  tasks: unknown[],
  overrides: Partial<NonNullable<NonNullable<Window['ue']>['editorwebui']>> = {},
  loadErrors: Array<{ module: string; error: string }> = [],
) {
  const commands = [
    {
      metadataVersion: 1,
      name: 'asset.scan',
      description: 'Scan assets',
      permission: 'read',
      schema: { type: 'object', properties: {} },
      category: 'Assets',
      icon: 'search',
      order: 10,
    },
    {
      metadataVersion: 1,
      name: 'asset.longScan',
      description: 'Long asset scan',
      permission: 'read',
      schema: { type: 'object', properties: {} },
      category: 'Assets',
      icon: 'timer',
      order: 20,
    },
    {
      metadataVersion: 1,
      name: 'system.toolPacks',
      description: 'Inspect Tool Pack deployment status',
      permission: 'read',
      schema: { type: 'object', properties: {} },
      category: 'System',
      icon: 'package',
      order: 30,
    },
  ]
  window.ue = {
    editorwebui: {
      executecommand: vi.fn(async (requestJson: string) => {
        const request = JSON.parse(requestJson) as { command?: string }
        if (request.command === 'system.commands') {
          return bridgeResponse({ metadataVersion: 1, commands, loadErrors })
        }
        if (request.command === 'system.toolPacks') {
          return bridgeResponse({
            statusVersion: 1,
            coreApiVersion: 1,
            packs: [],
            truncatedCount: 0,
          })
        }
        return bridgeResponse({})
      }),
      startcommand: vi.fn(async () => bridgeResponse({})),
      gettask: vi.fn(async () => bridgeResponse({})),
      listtasks: vi.fn(async () => bridgeResponse({ tasks })),
      removetask: vi.fn(async (taskId: string) => bridgeResponse({ taskId, removed: true })),
      canceltask: vi.fn(async () => bridgeResponse({})),
      getwebuisettings: vi.fn(async () => bridgeResponse({})),
      setwebuisettings: vi.fn(async () => bridgeResponse({})),
      ...overrides,
    },
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.ue
})

describe('task recovery', () => {
  it('keeps a restored task visible when backend removal fails', async () => {
    installBridge(
      [{ taskId: 'task-1', command: 'asset.scan', payload: {}, status: 'completed', progress: 100 }],
      { removetask: vi.fn(async () => bridgeError('backend refused removal')) },
    )
    render(<App />)

    expect(await screen.findByText('asset.scan')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect((await screen.findAllByText(/backend refused removal/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('asset.scan').length).toBeGreaterThan(0)
  })

  it('keeps an event-created running task non-terminal after a reconciliation error', async () => {
    installBridge(
      [],
      { listtasks: vi.fn(async () => bridgeError('temporary bridge failure')) },
    )
    render(<App />)

    fireEvent(window, new CustomEvent('unreal-editor-webui', {
      detail: {
        type: 'task.status',
        taskId: 'task-2',
        status: 'running',
        progress: 20,
      },
    }))

    expect(await screen.findByText(/temporary bridge failure/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('running')).toBeInTheDocument())
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })
})

describe('tool preferences', () => {
  it('restores project and open tabs from local storage', async () => {
    const storageNamespace = 'test-project'
    window.localStorage.setItem(
      toolPreferencesStorageKey(storageNamespace),
      JSON.stringify({
        schemaVersion: 1,
        data: {
        projectId: 'neon',
        stageId: 'art',
        categoryId: 'all',
        favorites: ['asset.scan'],
        openTabs: ['asset.longScan'],
        },
      }),
    )
    installBridge([], {
      getprojectcontext: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        projectName: 'Test Project',
        storageNamespace,
      })),
    })

    render(<App />)

    expect(await screen.findByDisplayValue('Project Neon')).toBeInTheDocument()
    expect((await screen.findAllByText('asset.longScan')).length).toBeGreaterThan(0)
  })

  it('renders a valid runtime catalog and marks its default selections active', async () => {
    installBridge([], {
      getprojectcontext: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        projectName: 'Custom Host',
        storageNamespace: 'custom-host',
      })),
      gettoolcatalog: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        source: 'project',
        catalog: customToolCatalog(),
        diagnosticCode: null,
      })),
    })

    const { container } = render(<App />)

    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute(
      'data-tool-catalog-source',
      'project',
    ))
    expect(container.querySelector('main')).toHaveAttribute('data-tool-catalog-schema-version', '1')
    expect(await screen.findByDisplayValue('Custom Project')).toBeInTheDocument()
    expect(container.querySelector('[data-tool-project-id="project-custom"]')).toHaveProperty('selected', true)
    expect(container.querySelector('[data-tool-stage-id="stage-custom"]')).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelector('[data-tool-category-id="category-custom"]')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Project catalog · schema v1')).toBeInTheDocument()
  })

  it('uses a fixed starter diagnostic without exposing raw invalid catalog fields', async () => {
    const secretPath = 'C:/Users/private/secret-catalog.json'
    installBridge([], {
      getprojectcontext: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        projectName: 'Invalid Host',
        storageNamespace: 'invalid-host',
      })),
      gettoolcatalog: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        source: 'project',
        catalog: { ...customToolCatalog(), machinePath: secretPath },
        diagnosticCode: null,
      })),
    })

    const { container } = render(<App />)

    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute(
      'data-tool-catalog-source',
      'starter',
    ))
    expect((await screen.findAllByText(/does not satisfy schema v1/)).length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain(secretPath)
    expect(screen.getByText('Starter catalog · schema v1')).toBeInTheDocument()
  })
})

describe('command discovery diagnostics', () => {
  it('keeps healthy commands available when one module fails to load', async () => {
    installBridge([], {}, [{ module: 'broken.commands', error: 'unsupported schema contract' }])

    render(<App />)

    expect(await screen.findByText('1 command module is unavailable.')).toBeInTheDocument()
    expect(screen.getByText('broken.commands')).toBeInTheDocument()
    expect(screen.getAllByText(/unsupported schema contract/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('asset.scan').length).toBeGreaterThan(0)
  })
})

describe('health and support report', () => {
  it('aggregates decoded status without exporting project, catalog, command, or task details', async () => {
    const projectName = 'Secret Host Project'
    const storageNamespace = 'project-secret-namespace'
    const moduleName = 'secret.command.module'
    const moduleError = 'C:/Users/private/source.py?token=do-not-export'
    const taskId = 'task-secret-id'
    const taskPayload = 'payload-secret-value'
    const taskResponse = 'response-secret-value'
    installBridge(
      [{
        taskId,
        command: 'secret.command',
        payload: { value: taskPayload },
        status: 'completed',
        progress: 100,
        logs: ['log-secret-value'],
        responseJson: taskResponse,
      }],
      {
        getwebuihealth: vi.fn(async () => bridgeResponse({
          protocolVersion: 1,
          bridgeProtocolVersion: 1,
          pluginVersion: '0.1.1',
          engineVersion: '5.8.0',
          documentScope: 'packaged',
          pythonRuntime: 'available',
          privilegedConfirmation: 'per_call',
          taskSessionIsolation: 'document',
        })),
        getprojectcontext: vi.fn(async () => bridgeResponse({
          protocolVersion: 1,
          projectName,
          storageNamespace,
        })),
        gettoolcatalog: vi.fn(async () => bridgeResponse({
          protocolVersion: 1,
          source: 'project',
          catalog: customToolCatalog(),
          diagnosticCode: null,
        })),
      },
      [{ module: moduleName, error: moduleError }],
    )

    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('[data-health-overall-status]')).toHaveAttribute(
      'data-health-overall-status',
      'degraded',
    ))
    await screen.findByText('secret.command')

    fireEvent.click(container.querySelector('[data-health-panel-toggle]') as HTMLButtonElement)
    fireEvent.click(container.querySelector('[data-support-report-generate]') as HTMLButtonElement)
    const preview = container.querySelector('textarea[data-support-report-preview]') as HTMLTextAreaElement
    const report = JSON.parse(preview.value) as Record<string, unknown>

    expect(report).toMatchObject({
      reportVersion: 2,
      product: 'unreal-editor-webui',
      health: {
        overallStatus: 'degraded',
        reasonCodes: ['health_registry_modules_rejected'],
      },
      native: {
        protocolVersion: 1,
        bridgeProtocolVersion: 1,
        pluginVersion: '0.1.1',
        engineVersion: '5.8.0',
        documentScope: 'packaged',
        pythonRuntime: 'available',
      },
      bridge: { lifecycle: 'ready', diagnosticCode: null },
      project: { persistence: 'enabled' },
      registry: { status: 'ready', availableCount: 3, loadErrorCount: 1 },
      catalog: { status: 'ready', source: 'project', schemaVersion: 1, diagnosticCode: null },
      toolPacks: {
        status: 'ready',
        diagnosticCode: null,
        statusVersion: 1,
        coreApiVersion: 1,
        loadedCount: 0,
        rejectedCount: 0,
        truncatedCount: 0,
        reasonCodes: [],
      },
      tasks: { completed: 1, total: 1 },
    })
    for (const secret of [
      projectName,
      storageNamespace,
      moduleName,
      moduleError,
      taskId,
      taskPayload,
      taskResponse,
      'secret.command',
      'log-secret-value',
      'project-custom',
      'stage-custom',
      'category-custom',
    ]) {
      expect(preview.value).not.toContain(secret)
    }
  })

  it('retries only the privacy-safe native health request from the health panel', async () => {
    const getWebUIHealth = vi.fn(async () => bridgeResponse({
      protocolVersion: 1,
      bridgeProtocolVersion: 1,
      pluginVersion: '0.1.1',
      engineVersion: '5.8.0',
      documentScope: 'packaged',
      pythonRuntime: 'available',
      privilegedConfirmation: 'per_call',
      taskSessionIsolation: 'document',
    }))
    const getProjectContext = vi.fn(async () => bridgeResponse({
      protocolVersion: 1,
      projectName: 'Retry Project',
      storageNamespace: 'retry-project',
    }))
    const getToolCatalog = vi.fn(async () => bridgeResponse({
      protocolVersion: 1,
      source: 'project',
      catalog: customToolCatalog(),
      diagnosticCode: null,
    }))
    installBridge([], {
      getwebuihealth: getWebUIHealth,
      getprojectcontext: getProjectContext,
      gettoolcatalog: getToolCatalog,
    })
    const executeCommand = vi.mocked(window.ue!.editorwebui!.executecommand)

    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('[data-health-overall-status]')).toHaveAttribute(
      'data-health-overall-status',
      'healthy',
    ))
    getWebUIHealth.mockClear()
    getProjectContext.mockClear()
    getToolCatalog.mockClear()
    executeCommand.mockClear()

    fireEvent.click(container.querySelector('[data-health-panel-toggle]') as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(getWebUIHealth).toHaveBeenCalledOnce())
    expect(getProjectContext).not.toHaveBeenCalled()
    expect(getToolCatalog).not.toHaveBeenCalled()
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('degrades aggregate health with a fixed reason when a Tool Pack is rejected', async () => {
    installBridge([], {
      getwebuihealth: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        bridgeProtocolVersion: 1,
        pluginVersion: '0.1.1',
        engineVersion: '5.8.0',
        documentScope: 'packaged',
        pythonRuntime: 'available',
        privilegedConfirmation: 'per_call',
        taskSessionIsolation: 'document',
      })),
      getprojectcontext: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        projectName: 'Tool Pack Host',
        storageNamespace: 'tool-pack-host',
      })),
      gettoolcatalog: vi.fn(async () => bridgeResponse({
        protocolVersion: 1,
        source: 'project',
        catalog: customToolCatalog(),
        diagnosticCode: null,
      })),
    })
    const defaultExecute = window.ue!.editorwebui!.executecommand
    window.ue!.editorwebui!.executecommand = vi.fn(async (requestJson: string) => {
      const request = JSON.parse(requestJson) as { command?: string }
      if (request.command === 'system.toolPacks') {
        return bridgeResponse({
          statusVersion: 1,
          coreApiVersion: 1,
          packs: [{
            provider: 'studio.legacy',
            packId: 'studio.legacy',
            pluginName: 'StudioLegacy',
            pluginVersion: '0.9.0',
            requiredCoreApi: 2,
            state: 'rejected',
            commandCount: 0,
            commands: [],
          }],
          truncatedCount: 0,
        })
      }
      return defaultExecute(requestJson)
    })

    const { container } = render(<App />)
    await waitFor(() => expect(container.querySelector('[data-health-overall-status]')).toHaveAttribute(
      'data-health-overall-status',
      'degraded',
    ))
    fireEvent.click(container.querySelector('[data-health-panel-toggle]') as HTMLButtonElement)
    expect(screen.getByText('One or more Tool Packs were rejected.')).toBeInTheDocument()

    fireEvent.click(container.querySelector('[data-support-report-generate]') as HTMLButtonElement)
    const preview = container.querySelector('textarea[data-support-report-preview]') as HTMLTextAreaElement
    expect(JSON.parse(preview.value)).toMatchObject({
      health: {
        overallStatus: 'degraded',
        reasonCodes: ['health_tool_packs_rejected'],
      },
      toolPacks: {
        status: 'ready',
        loadedCount: 0,
        rejectedCount: 1,
        truncatedCount: 0,
        reasonCodes: ['tool_pack_core_api_mismatch'],
      },
    })
  })

  it('keeps the rack usable and exports only fixed aggregates when Tool Pack status is malformed', async () => {
    const secret = 'C:/Users/private/tool-pack.py?token=do-not-export'
    installBridge([])
    const defaultExecute = window.ue!.editorwebui!.executecommand
    window.ue!.editorwebui!.executecommand = vi.fn(async (requestJson: string) => {
      const request = JSON.parse(requestJson) as { command?: string }
      if (request.command === 'system.toolPacks') {
        return bridgeResponse({
          statusVersion: 1,
          coreApiVersion: 1,
          packs: [],
          truncatedCount: 0,
          privatePath: secret,
        })
      }
      return defaultExecute(requestJson)
    })

    const { container } = render(<App />)
    expect((await screen.findAllByText('asset.scan')).length).toBeGreaterThan(0)
    fireEvent.click(container.querySelector('[data-health-panel-toggle]') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('[data-tool-pack-status]')).toHaveAttribute(
      'data-tool-pack-status',
      'malformed',
    ))
    expect(screen.getByText('The Tool Pack status response does not satisfy schema v1.')).toHaveAttribute(
      'role',
      'alert',
    )
    expect(container.textContent).not.toContain(secret)

    fireEvent.click(container.querySelector('[data-support-report-generate]') as HTMLButtonElement)
    const preview = container.querySelector('textarea[data-support-report-preview]') as HTMLTextAreaElement
    expect(JSON.parse(preview.value)).toMatchObject({
      reportVersion: 2,
      toolPacks: {
        status: 'malformed',
        diagnosticCode: 'tool_pack_response_invalid',
        statusVersion: null,
        coreApiVersion: null,
        loadedCount: 0,
        rejectedCount: 0,
        truncatedCount: 0,
        reasonCodes: [],
      },
    })
    expect(preview.value).not.toContain(secret)
  })
})
