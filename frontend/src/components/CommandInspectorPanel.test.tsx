import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CommandMetadata } from '../types/command'
import { CommandInspectorPanel } from './CommandInspectorPanel'

const command: CommandMetadata = {
  metadataVersion: 1,
  name: 'asset.scan',
  description: 'Scan assets.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
}

const baseProps = {
  bridgeReady: true,
  favorite: false,
  recentExecutions: [],
  selectedCommand: command,
  getFieldValue: vi.fn(),
  onClearPayload: vi.fn(),
  onFieldChange: vi.fn(),
  onLoadDefaults: vi.fn(),
  onLoadPayload: vi.fn(),
  onRun: vi.fn(),
  onStartTask: vi.fn(),
  onToggleFavorite: vi.fn(),
}

describe('CommandInspectorPanel', () => {
  it('disables both dispatch paths while a command is pending', () => {
    render(<CommandInspectorPanel
      {...baseProps}
      invocation={{
        status: 'pending',
        mode: 'run',
        invocation: 1,
        stale: false,
        startedAt: '2026-08-02T00:00:00Z',
        message: 'Running command…',
      }}
    />)

    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Running command')
  })

  it('shows command failures next to the dispatch controls', () => {
    render(<CommandInspectorPanel
      {...baseProps}
      invocation={{
        status: 'error',
        mode: 'run',
        invocation: 2,
        stale: true,
        startedAt: '2026-08-02T00:00:00Z',
        finishedAt: '2026-08-02T00:00:01Z',
        error: '[invalid_payload] size is required',
      }}
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('[invalid_payload] size is required')
  })
})
