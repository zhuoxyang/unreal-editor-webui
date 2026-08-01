import { useRef, useState } from 'react'
import { createRequestId, formatBridgeError, type BridgeCaller } from '../bridge'
import { decodeTaskResult } from '../bridge-decoders'
import type { ExecutionMode } from '../recent-executions'
import type { TaskResult } from '../types/bridge'
import type { CommandMetadata } from '../types/command'
import type { TaskRecord } from '../types/task'

export type CommandInvocationState = {
  status: 'pending' | 'success' | 'error'
  mode: ExecutionMode
  invocation: number
  stale: boolean
  startedAt: string
  finishedAt?: string
  message?: string
  error?: string
}

type UseCommandRunnerOptions = {
  buildPayload: (command: CommandMetadata) => Record<string, unknown>
  callBridge: BridgeCaller
  log: (message: string) => void
  mergeTaskResult: (task: TaskResult, fallback?: Partial<TaskRecord>) => void
  recordRecentExecution: (command: CommandMetadata, payload: Record<string, unknown>, mode: ExecutionMode) => void
}

function hasOwnResult(results: Record<string, unknown>, commandName: string) {
  return Object.prototype.hasOwnProperty.call(results, commandName)
}

export function useCommandRunner({
  buildPayload,
  callBridge,
  log,
  mergeTaskResult,
  recordRecentExecution,
}: UseCommandRunnerOptions) {
  const [commandResults, setCommandResults] = useState<Record<string, unknown>>({})
  const [commandInvocations, setCommandInvocations] = useState<Record<string, CommandInvocationState>>({})
  const commandResultsRef = useRef(commandResults)
  const invocationSequenceRef = useRef(new Map<string, number>())
  const pendingCommandsRef = useRef(new Set<string>())
  async function runCommand<T>(command: string, payload: Record<string, unknown> = {}) {
    return callBridge<T>('executecommand', JSON.stringify({
      id: createRequestId(),
      command,
      payload,
    }))
  }

  async function startCommand(command: string, payload: Record<string, unknown> = {}) {
    const result = await callBridge<unknown>('startcommand', JSON.stringify({
      id: createRequestId(),
      command,
      payload,
    }))
    return decodeTaskResult('startcommand', result)
  }

  function beginInvocation(commandName: string, mode: ExecutionMode) {
    if (pendingCommandsRef.current.has(commandName)) {
      return null
    }

    pendingCommandsRef.current.add(commandName)
    const invocation = (invocationSequenceRef.current.get(commandName) || 0) + 1
    invocationSequenceRef.current.set(commandName, invocation)
    const startedAt = new Date().toISOString()
    setCommandInvocations((states) => ({
      ...states,
      [commandName]: {
        status: 'pending',
        mode,
        invocation,
        stale: hasOwnResult(commandResultsRef.current, commandName),
        startedAt,
        message: mode === 'run' ? 'Running command…' : 'Starting task…',
      },
    }))
    return { invocation, startedAt }
  }

  function isLatestInvocation(commandName: string, invocation: number) {
    return invocationSequenceRef.current.get(commandName) === invocation
  }

  function finishInvocation(commandName: string, invocation: number) {
    if (isLatestInvocation(commandName, invocation)) {
      pendingCommandsRef.current.delete(commandName)
    }
  }

  async function runCommandFromMetadata(command: CommandMetadata) {
    const started = beginInvocation(command.name, 'run')
    if (!started) {
      return
    }

    try {
      const payload = buildPayload(command)
      const result = await runCommand<unknown>(command.name, payload)
      if (!isLatestInvocation(command.name, started.invocation)) {
        return
      }

      recordRecentExecution(command, payload, 'run')
      setCommandResults((results) => {
        const next = { ...results, [command.name]: result }
        commandResultsRef.current = next
        return next
      })
      setCommandInvocations((states) => ({
        ...states,
        [command.name]: {
          status: 'success',
          mode: 'run',
          invocation: started.invocation,
          stale: false,
          startedAt: started.startedAt,
          finishedAt: new Date().toISOString(),
          message: 'Run completed.',
        },
      }))
    } catch (error) {
      if (isLatestInvocation(command.name, started.invocation)) {
        const message = formatBridgeError(error)
        setCommandInvocations((states) => ({
          ...states,
          [command.name]: {
            status: 'error',
            mode: 'run',
            invocation: started.invocation,
            stale: hasOwnResult(commandResultsRef.current, command.name),
            startedAt: started.startedAt,
            finishedAt: new Date().toISOString(),
            error: message,
          },
        }))
        log(message)
      }
    } finally {
      finishInvocation(command.name, started.invocation)
    }
  }

  async function startTaskFromMetadata(command: CommandMetadata) {
    const started = beginInvocation(command.name, 'task')
    if (!started) {
      return
    }

    try {
      const payload = buildPayload(command)
      const task = await startCommand(command.name, payload)
      if (!isLatestInvocation(command.name, started.invocation)) {
        return
      }

      mergeTaskResult(task, {
        command: command.name,
        payload,
        startedAt: new Date().toISOString(),
      })
      const message = `${command.name} task started -> ${task.taskId}`
      log(message)
      recordRecentExecution(command, payload, 'task')
      setCommandInvocations((states) => ({
        ...states,
        [command.name]: {
          status: 'success',
          mode: 'task',
          invocation: started.invocation,
          stale: hasOwnResult(commandResultsRef.current, command.name),
          startedAt: started.startedAt,
          finishedAt: new Date().toISOString(),
          message: `Task ${task.taskId} queued.`,
        },
      }))
    } catch (error) {
      if (isLatestInvocation(command.name, started.invocation)) {
        const message = formatBridgeError(error)
        setCommandInvocations((states) => ({
          ...states,
          [command.name]: {
            status: 'error',
            mode: 'task',
            invocation: started.invocation,
            stale: hasOwnResult(commandResultsRef.current, command.name),
            startedAt: started.startedAt,
            finishedAt: new Date().toISOString(),
            error: message,
          },
        }))
        log(message)
      }
    } finally {
      finishInvocation(command.name, started.invocation)
    }
  }

  return {
    commandInvocations,
    commandResults,
    runCommandFromMetadata,
    startTaskFromMetadata,
  }
}
