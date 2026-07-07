import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SchemaForm } from './SchemaForm'
import { getDefaultValue } from '../hooks/useCommandPayloads'
import type { CommandMetadata } from '../types/command'

const command: CommandMetadata = {
  name: 'asset.example',
  description: 'Example command',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['fast', 'safe'],
        default: 'safe',
      },
      dryRun: {
        type: 'boolean',
        default: true,
        xDryRun: true,
      },
      filters: {
        type: 'array',
        default: ['SM_'],
      },
    },
    required: ['mode'],
  },
}

describe('SchemaForm', () => {
  it('renders typed fields and reports changes', () => {
    const onFieldChange = vi.fn()
    render(
      <SchemaForm
        command={command}
        getFieldValue={(_, fieldName, property) => getDefaultValue(property) || fieldName}
        onClear={vi.fn()}
        onFieldChange={onFieldChange}
        onLoadDefaults={vi.fn()}
        onLoadPayload={vi.fn()}
        recentExecutions={[]}
      />,
    )

    fireEvent.change(screen.getByLabelText(/mode/), { target: { value: JSON.stringify({ value: 'fast' }) } })
    fireEvent.click(screen.getByLabelText(/dryRun/))
    fireEvent.change(screen.getByLabelText(/filters/), { target: { value: '["T_"]' } })

    expect(onFieldChange).toHaveBeenCalledWith('asset.example', 'mode', 'fast')
    expect(onFieldChange).toHaveBeenCalledWith('asset.example', 'dryRun', false)
    expect(onFieldChange).toHaveBeenCalledWith('asset.example', 'filters', '["T_"]')
  })

  it('renders recent payload presets', () => {
    const onLoadPayload = vi.fn()
    render(
      <SchemaForm
        command={command}
        getFieldValue={(_, _fieldName, property) => getDefaultValue(property)}
        onClear={vi.fn()}
        onFieldChange={vi.fn()}
        onLoadDefaults={vi.fn()}
        onLoadPayload={onLoadPayload}
        recentExecutions={[{
          id: 'recent-1',
          command: 'asset.example',
          mode: 'task',
          payload: { mode: 'fast' },
          ranAt: '2026-07-07T06:00:00Z',
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Task/ }))
    expect(onLoadPayload).toHaveBeenCalledWith(command, { mode: 'fast' })
  })
})
