import { useEffect, useRef, useState } from 'react'
import { createRequestId } from '../bridge'
import {
  cloneExecutionPayload,
  loadStoredRecentExecutionsState,
  MAX_RECENT_EXECUTIONS,
  saveStoredRecentExecutions,
  type ExecutionMode,
  type RecentExecution,
} from '../recent-executions'
import type { CommandMetadata } from '../types/command'

export function useRecentExecutions() {
  const [initialLoad] = useState(loadStoredRecentExecutionsState)
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(initialLoad.value)
  const hasUserChangedRef = useRef(false)

  useEffect(() => {
    if (!initialLoad.needsRewrite && !hasUserChangedRef.current) {
      return
    }
    saveStoredRecentExecutions(recentExecutions)
  }, [initialLoad.needsRewrite, recentExecutions])

  function recordRecentExecution(command: CommandMetadata, payload: Record<string, unknown>, mode: ExecutionMode) {
    hasUserChangedRef.current = true
    const payloadSnapshot = cloneExecutionPayload(payload)
    setRecentExecutions((items) => {
      const payloadKey = JSON.stringify(payloadSnapshot)
      const nextItem: RecentExecution = {
        id: createRequestId(),
        command: command.name,
        mode,
        payload: payloadSnapshot,
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

