import { useEffect, useRef, useState } from 'react'
import { createRequestId } from '../bridge'
import {
  clearStoredRecentExecutions,
  cloneExecutionPayload,
  loadStoredRecentExecutionsState,
  MAX_RECENT_EXECUTIONS,
  saveStoredRecentExecutions,
  type ExecutionMode,
  type RecentExecution,
} from '../recent-executions'
import type { CommandMetadata } from '../types/command'

export function useRecentExecutions(storageNamespace?: string | null) {
  const [initialLoad] = useState(() => loadStoredRecentExecutionsState(storageNamespace))
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>(initialLoad.value)
  const hasUserChangedRef = useRef(false)
  const hasMountedRef = useRef(false)
  const suppressNextSaveRef = useRef(false)

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      if (initialLoad.needsRewrite) {
        saveStoredRecentExecutions(initialLoad.value, storageNamespace)
      }
      return
    }

    const loaded = loadStoredRecentExecutionsState(storageNamespace)
    hasUserChangedRef.current = false
    suppressNextSaveRef.current = true
    setRecentExecutions(loaded.value)
    if (loaded.needsRewrite) {
      saveStoredRecentExecutions(loaded.value, storageNamespace)
    }
  }, [initialLoad, storageNamespace])

  useEffect(() => {
    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false
      return
    }
    if (!hasUserChangedRef.current) {
      return
    }
    saveStoredRecentExecutions(recentExecutions, storageNamespace)
    hasUserChangedRef.current = false
  }, [recentExecutions, storageNamespace])

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

  function clearRecentExecutions() {
    clearStoredRecentExecutions(storageNamespace)
    hasUserChangedRef.current = true
    setRecentExecutions([])
  }

  return { clearRecentExecutions, recentExecutions, recordRecentExecution }
}
