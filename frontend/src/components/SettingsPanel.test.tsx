import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { SettingsPanel } from './SettingsPanel'

const settings = {
  useDevServer: false,
  devServerUrl: 'http://localhost:5173',
  startupUrl: '',
  resolvedUrl: 'file:///plugin/index.html',
}

function renderSettings(callBridgeQuiet: BridgeCaller) {
  render(
    <SettingsPanel
      bridgeReady
      callBridge={vi.fn().mockResolvedValue(settings) as BridgeCaller}
      callBridgeQuiet={callBridgeQuiet}
      log={vi.fn()}
      onClearLocalData={vi.fn()}
      persistenceEnabled={false}
      projectContextReady
      projectName="Unknown project"
    />,
  )
}

describe('SettingsPanel', () => {
  it('keeps retry available when the initial settings request fails', async () => {
    const callBridgeQuiet = vi.fn()
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce(settings) as BridgeCaller
    renderSettings(callBridgeQuiet)

    expect(await screen.findByRole('alert')).toHaveTextContent('settings unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading settings' }))

    await waitFor(() => expect(screen.getByDisplayValue('http://localhost:5173')).toBeInTheDocument())
  })

  it('renders malformed settings as a protocol error', async () => {
    renderSettings(vi.fn().mockResolvedValue({ ...settings, resolvedUrl: null }) as BridgeCaller)
    expect(await screen.findByRole('alert')).toHaveTextContent('resolvedUrl')
    expect(screen.getByText(/Project context unavailable; persistence is disabled/)).toBeInTheDocument()
  })
})
