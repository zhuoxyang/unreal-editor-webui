import { useState } from 'react'
import { createRequestId, type BridgeCaller } from '../bridge'
import type { ExecutionMode } from '../recent-executions'
import type { TaskResult } from '../types/bridge'
import type { CommandMetadata } from '../types/command'
import type { TaskRecord } from '../types/task'

type UseCommandRunnerOptions = {
  buildPayload: (command: CommandMetadata) => Record<string, unknown>
  callBridge: BridgeCaller
  log: (message: string) => void
  mergeTaskResult: (task: TaskResult, fallback?: Partial<TaskRecord>) => void
  recordRecentExecution: (command: CommandMetadata, payload: Record<string, unknown>, mode: ExecutionMode) => void
}

export function useCommandRunner({
  buildPayload,
  callBridge,
  log,
  mergeTaskResult,
  recordRecentExecution,
}: UseCommandRunnerOptions) {
  const [commandResults, setCommandResults] = useState<Record<string, unknown>>({})

  async function runCommand<T>(command: string, payload: Record<string, unknown> = {}) {
    return callBridge<T>('executecommand', JSON.stringify({
      id: createRequestId(),
      command,
      payload,
    }))
  }

  async function startCommand(command: string, payload: Record<string, unknown> = {}) {
    return callBridge<TaskResult>('startcommand', JSON.stringify({
      id: createRequestId(),
      command,
      payload,
    }))
  }

  async function runCommandFromMetadata(command: CommandMetadata) {
    try {
      const payload = buildPayload(command)
      const result = await runCommand<unknown>(command.name, payload)
      recordRecentExecution(command, payload, 'run')
      setCommandResults((results) => ({
        ...results,
        [command.name]: result,
      }))
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  async function startTaskFromMetadata(command: CommandMetadata) {
    try {
      const payload = buildPayload(command)
      const task = await startCommand(command.name, payload)
      mergeTaskResult(task, {
        command: command.name,
        payload,
        startedAt: new Date().toISOString(),
      })
      log(`${command.name} task started -> ${task.taskId}`)
      recordRecentExecution(command, payload, 'task')
    } catch (error) {
      log(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    commandResults,
    runCommandFromMetadata,
    startTaskFromMetadata,
  }
}

