import { useEffect, useState } from 'react'
import { createRequestId } from '../bridge'
import {
  loadStoredRecentExecutions,
  MAX_RECENT_EXECUTIONS,
  saveStoredRecentExecutions,
  type ExecutionMode,
  type RecentExecution,
} from '../recent-executions'
import type { CommandMetadata } from '../types/command'

export function useRecentExecutions() {
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(loadStoredRecentExecutions)

  useEffect(() => {
    saveStoredRecentExecutions(recentExecutions)
  }, [recentExecutions])

  function recordRecentExecution(command: CommandMetadata, payload: Record<string, unknown>, mode: ExecutionMode) {
    setRecentExecutions((items) => {
      const payloadKey = JSON.stringify(payload)
      const nextItem: RecentExecution = {
        id: createRequestId(),
        command: command.name,
        mode,
        payload,
        ranAt: new Date().toISOString(),
      }

      return [
        nextItem,
        ...items.filter((item) => item.command !== command.name || JSON.stringify(item.payload) !== payloadKey),
      ].slice(0, MAX_RECENT_EXECUTIONS)
    })
  }

  return { recentExecutions, recordRecentExecution }
}

