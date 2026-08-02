import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../types/task'
import { TaskCard } from './TaskCard'

function task(status: TaskRecord['status'], updatedAt: string): TaskRecord {
  return {
    taskId: 'task-1',
    command: 'demo.longRun',
    payload: {},
    status,
    progress: status === 'completed' ? 100 : 50,
    startedAt: '2026-08-02T00:00:00.000Z',
    updatedAt,
  }
}

describe('TaskCard', () => {
  it('reloads detail when an expanded running task becomes terminal', async () => {
    const onLoadDetails = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const commonProps = {
      bridgeReady: true,
      onCancel: vi.fn(),
      onLoadDetails,
      onRemove: vi.fn(),
    }
    const { container, rerender } = render(
      <TaskCard {...commonProps} task={task('running', '2026-08-02T00:00:01.000Z')} />,
    )
    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    if (!details) return

    details.open = true
    fireEvent(details, new Event('toggle', { bubbles: true }))
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(1))

    rerender(
      <TaskCard {...commonProps} task={task('completed', '2026-08-02T00:00:02.000Z')} />,
    )
    await waitFor(() => expect(onLoadDetails).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Details')).toBeInTheDocument()
  })

  it('renders decoded structured data for a failed task response', () => {
    const failedTask = {
      ...task('failed', '2026-08-02T00:00:02.000Z'),
      responseJson: JSON.stringify({
        id: 'req-1',
        ok: false,
        error: {
          code: 'batch_failed',
          message: 'No asset could be changed.',
          data: {
            protocolVersion: 1,
            view: 'changeSet',
            summary: {
              label: 'asset.renameBatch',
              dryRun: false,
              save: false,
              status: 'failed',
              changed: 0,
              changedUnsaved: 0,
              skipped: 0,
              failed: 1,
              total: 1,
            },
            changeSet: [{
              assetPath: '/Game/Props/SM_OldChair',
              propertyPath: 'objectPath',
              before: '/Game/Props/SM_OldChair',
              after: '/Game/Props/SM_NewChair',
              action: 'rename',
              status: 'failed',
              message: 'Unreal rejected the asset rename.',
            }],
          },
        },
      }),
    }

    render(<TaskCard
      bridgeReady
      onCancel={vi.fn()}
      onLoadDetails={vi.fn()}
      onRemove={vi.fn()}
      resultType="changeSet"
      task={failedTask}
    />)

    expect(screen.getByRole('alert')).toHaveTextContent('[batch_failed] No asset could be changed.')
    expect(screen.getAllByText('/Game/Props/SM_OldChair')).toHaveLength(2)
    expect(screen.getByText('Unreal rejected the asset rename.')).toBeInTheDocument()
  })
})
