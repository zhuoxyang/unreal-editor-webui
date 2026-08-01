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
})
