import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BridgeCaller } from '../bridge'
import { useCommands } from './useCommands'

const commandResult = {
  commands: [{
    name: 'asset.scan',
    description: 'Scan assets.',
    permission: 'read',
    schema: { type: 'object', properties: {} },
  }],
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

  it('shows a protocol error instead of accepting malformed command metadata', async () => {
    const callBridgeQuiet = vi.fn().mockResolvedValue({
      commands: [{ ...commandResult.commands[0], schema: null }],
    }) as BridgeCaller
    const log = vi.fn()
    const { result } = renderHook(() => useCommands({
      bridgeReady: true,
      callBridgeQuiet,
      log,
    }))

    await waitFor(() => expect(result.current.commandsStatus).toBe('error'))
    expect(result.current.commandsError).toContain('commands[0].schema')
  })
})
