import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { useCommands } from './useCommands'

const commandResult = {
  metadataVersion: 1,
  commands: [{
    metadataVersion: 1,
    name: 'asset.scan',
    description: 'Scan assets.',
    permission: 'read',
    schema: { type: 'object', properties: {} },
  }],
  loadErrors: [],
}

describe('useCommands', () => {
  it('exposes an actionable retry after a transient initial failure', async () => {
    const callBridgeQuiet = vi.fn()
      .mockRejectedValueOnce(new Error('registry is starting'))
      .mockResolvedValueOnce(commandResult) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useCommands({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.commandsStatus).toBe('error'))
    expect(result.current.commandsError).toBe('registry is starting')

    await act(async () => result.current.retryCommands())
    expect(result.current.commandsStatus).toBe('ready')
    expect(result.current.commands[0].name).toBe('asset.scan')
  })

  it('shows a protocol error for an incompatible catalogue version', async () => {
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      ...commandResult,
      metadataVersion: 2,
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useCommands({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.commandsStatus).toBe('error'))
    expect(result.current.commandsError).toContain('metadataVersion 1')
  })

  it('keeps healthy commands ready and exposes load diagnostics', async () => {
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      ...commandResult,
      commands: [
        commandResult.commands[0],
        { ...commandResult.commands[0], name: 'asset.invalid', schema: null },
      ],
      loadErrors: [{ module: 'plugin.broken', error: 'module import failed' }],
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useCommands({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.commandsStatus).toBe('ready'))
    expect(result.current.commands.map((command) => command.name)).toEqual(['asset.scan'])
    expect(result.current.commandsLoadErrors.map((loadError) => loadError.module)).toEqual([
      'plugin.broken',
      'asset.invalid',
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plugin.broken'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('asset.invalid'))
  })
})
