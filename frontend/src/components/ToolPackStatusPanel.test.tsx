import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolPackStatusV1 } from '../types/bridge'
import { ToolPackStatusPanel } from './ToolPackStatusPanel'

const STATUS: ToolPackStatusV1 = {
  statusVersion: 1,
  coreApiVersion: 1,
  packs: [
    {
      provider: 'studio.assets',
      packId: 'studio.assets',
      pluginName: 'StudioAssets',
      pluginVersion: '1.2.0',
      requiredCoreApi: 1,
      state: 'loaded',
      commandCount: 2,
      commands: ['asset.audit', 'asset.scan'],
    },
    {
      provider: 'studio.legacy',
      packId: 'studio.legacy',
      pluginName: 'StudioLegacy',
      pluginVersion: '0.9.0',
      requiredCoreApi: 2,
      state: 'rejected',
      commandCount: 0,
      commands: [],
    },
    {
      provider: null,
      packId: null,
      pluginName: 'BrokenDescriptor',
      pluginVersion: null,
      requiredCoreApi: null,
      state: 'rejected',
      commandCount: 0,
      commands: [],
    },
  ],
  truncatedCount: 9,
}

describe('ToolPackStatusPanel', () => {
  it('renders bounded v1 deployment details, rejection categories, and static restart guidance', () => {
    const { container } = render(<ToolPackStatusPanel
      canRetry={false}
      diagnosticCode={null}
      loadStatus="ready"
      onRetry={vi.fn()}
      status={STATUS}
    />)

    expect(container.querySelector('[data-tool-pack-status]')).toHaveAttribute('data-tool-pack-status', 'ready')
    expect(screen.getByText(/1 loaded · 2 rejected · core API v1/)).toBeInTheDocument()
    expect(screen.getByText('studio.assets')).toBeInTheDocument()
    expect(screen.getByText(/2 commands: asset.audit, asset.scan/)).toBeInTheDocument()
    expect(screen.getByText(/requires a different core API version/)).toBeInTheDocument()
    expect(screen.getByText(/descriptor discovery/)).toBeInTheDocument()
    expect(screen.getByText(/9 cumulative Tool Pack status observations were omitted/)).toBeInTheDocument()
    expect(screen.getByText(/Restart Unreal Editor after installing, enabling, updating, disabling, or removing/)).toBeInTheDocument()
    expect(container.textContent).not.toContain('restartRequired')
  })

  it('renders the explicit empty and loading states', () => {
    const empty = render(<ToolPackStatusPanel
      canRetry={false}
      diagnosticCode={null}
      loadStatus="ready"
      onRetry={vi.fn()}
      status={{ ...STATUS, packs: [], truncatedCount: 0 }}
    />)
    expect(screen.getByText('No third-party Tool Packs discovered.')).toBeInTheDocument()
    empty.unmount()

    render(<ToolPackStatusPanel
      canRetry={false}
      diagnosticCode={null}
      loadStatus="loading"
      onRetry={vi.fn()}
      status={null}
    />)
    expect(screen.getByText(/Checking Tool Pack deployment status/)).toBeInTheDocument()
  })

  it('uses fixed diagnostics and exposes retry only when permitted', () => {
    const onRetry = vi.fn()
    const secret = 'C:/Users/private/tool-pack.py?token=secret'
    const { container } = render(<ToolPackStatusPanel
      canRetry
      diagnosticCode="tool_pack_response_invalid"
      loadStatus="malformed"
      onRetry={onRetry}
      status={null}
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('does not satisfy schema v1')
    expect(container.textContent).not.toContain(secret)
    fireEvent.click(screen.getByRole('button', { name: 'Check Tool Packs again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
