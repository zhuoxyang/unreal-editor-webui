import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function bridgeResponse(result: unknown) {
  return JSON.stringify({ id: null, ok: true, result })
}

function bridgeError(message: string) {
  return JSON.stringify({ id: null, ok: false, error: { code: 'test_error', message } })
}

function installBridge(tasks: unknown[], overrides: Partial<NonNullable<NonNullable<Window['ue']>['editorwebui']>> = {}) {
  const commands = [
    {
      name: 'asset.scan',
      description: 'Scan assets',
      permission: 'read',
      schema: { type: 'object', properties: {} },
      category: 'Assets',
      icon: 'search',
      order: 10,
    },
    {
      name: 'asset.longScan',
      description: 'Long asset scan',
      permission: 'read',
      schema: { type: 'object', properties: {} },
      category: 'Assets',
      icon: 'timer',
      order: 20,
    },
  ]
  window.ue = {
    editorwebui: {
      executecommand: vi.fn(async (requestJson: string) => {
        const request = JSON.parse(requestJson) as { command?: string }
        if (request.command === 'system.commands') {
          return bridgeResponse({ commands })
        }
        return bridgeResponse({})
      }),
      startcommand: vi.fn(async () => bridgeResponse({})),
      gettask: vi.fn(async () => bridgeResponse({})),
      listtasks: vi.fn(async () => bridgeResponse({ tasks })),
      removetask: vi.fn(async () => bridgeResponse({ removed: true })),
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

    expect(await screen.findByText('backend refused removal')).toBeInTheDocument()
    expect(screen.getAllByText('asset.scan').length).toBeGreaterThan(0)
  })

  it('keeps a running task non-terminal after a transient polling error', async () => {
    installBridge(
      [{ taskId: 'task-2', command: 'asset.longScan', payload: {}, status: 'running', progress: 20 }],
      { gettask: vi.fn(async () => bridgeError('temporary bridge failure')) },
    )
    render(<App />)

    expect((await screen.findAllByText('asset.longScan')).length).toBeGreaterThan(0)
    expect(await screen.findByText('temporary bridge failure')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('running')).toBeInTheDocument())
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })
})

describe('tool preferences', () => {
  it('restores project and open tabs from local storage', async () => {
    window.localStorage.setItem(
      'unreal-editor-webui.toolPreferences',
      JSON.stringify({
        projectId: 'neon',
        stageId: 'art',
        categoryId: 'all',
        favorites: ['asset.scan'],
        openTabs: ['asset.longScan'],
      }),
    )
    installBridge([])

    render(<App />)

    expect(await screen.findByDisplayValue('Project Neon')).toBeInTheDocument()
    expect((await screen.findAllByText('asset.longScan')).length).toBeGreaterThan(0)
  })
})
