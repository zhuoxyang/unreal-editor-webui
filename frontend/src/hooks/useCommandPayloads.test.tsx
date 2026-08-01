import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CommandMetadata } from '../types/command'
import { useCommandPayloads } from './useCommandPayloads'

function numericCommand(required = true): CommandMetadata {
  return {
    name: 'asset.resize',
    description: 'Resize an asset.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        size: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          exclusiveMinimum: 0,
          exclusiveMaximum: 11,
        },
      },
      required: required ? ['size'] : [],
    },
  }
}

describe('useCommandPayloads', () => {
  it('never coerces an empty required number to zero', () => {
    const { result } = renderHook(() => useCommandPayloads())

    expect(() => result.current.buildPayload(numericCommand())).toThrow('asset.resize.size is required')

    act(() => result.current.updateField('asset.resize', 'size', '   '))
    expect(() => result.current.buildPayload(numericCommand())).toThrow('asset.resize.size is required')
  })

  it('omits blank optional numbers and validates numeric bounds', () => {
    const { result } = renderHook(() => useCommandPayloads())
    expect(result.current.buildPayload(numericCommand(false))).toEqual({})

    act(() => result.current.updateField('asset.resize', 'size', '12'))
    expect(() => result.current.buildPayload(numericCommand(false))).toThrow('less than or equal to 10')

    act(() => result.current.updateField('asset.resize', 'size', '5'))
    expect(result.current.buildPayload(numericCommand(false))).toEqual({ size: 5 })
  })
})
