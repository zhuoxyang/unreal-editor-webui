import { describe, expect, it } from 'vitest'
import {
  decodeCommandsResult,
  decodeProjectContext,
  decodeRemoveTaskResult,
  decodeTaskListResult,
  decodeTaskResult,
  decodeWebUISettings,
} from './bridge-decoders'

const command = {
  name: 'asset.scan',
  description: 'Scan assets.',
  permission: 'read',
  schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } },
}

describe('bridge result decoders', () => {
  it('accepts well-formed command metadata and rejects unsafe shapes', () => {
    expect(decodeCommandsResult({ commands: [command] }).commands).toHaveLength(1)
    expect(() => decodeCommandsResult({ commands: [{ ...command, schema: null }] })).toThrow(
      'commands[0].schema',
    )
    expect(() => decodeCommandsResult({ commands: [command, command] })).toThrow('duplicate command name')
  })

  it('validates task bodies for every task method', () => {
    const task = { taskId: 'task-1', status: 'running', progress: 50, logs: ['started'] }
    expect(decodeTaskResult('startcommand', task)).toEqual(task)
    expect(() => decodeTaskResult('gettask', task, 'task-other')).toThrow('instead of "task-other"')
    expect(() => decodeTaskResult('canceltask', { ...task, logs: 'broken' })).toThrow(
      'field "logs" must be an array of strings',
    )
    expect(decodeTaskListResult({ tasks: [task] })).toEqual([task])
    expect(() => decodeTaskListResult({ tasks: [task, task] })).toThrow('duplicate task id')
  })

  it('validates removal and settings bodies', () => {
    expect(decodeRemoveTaskResult({ taskId: 'task-1', removed: true }, 'task-1')).toEqual({ taskId: 'task-1', removed: true })
    expect(() => decodeRemoveTaskResult({ taskId: 'task-other', removed: true }, 'task-1')).toThrow('taskId "task-1"')
    expect(() => decodeRemoveTaskResult({ taskId: 'task-1', removed: 'yes' }, 'task-1')).toThrow('boolean removed')

    const settings = {
      useDevServer: false,
      devServerUrl: 'http://localhost:5173',
      startupUrl: '',
      resolvedUrl: 'file:///plugin/index.html',
    }
    expect(decodeWebUISettings('getwebuisettings', settings)).toEqual(settings)
    expect(() => decodeWebUISettings('setwebuisettings', { ...settings, resolvedUrl: null })).toThrow(
      'resolvedUrl',
    )
  })

  it('validates project storage context', () => {
    expect(decodeProjectContext({ protocolVersion: 1, projectName: 'Example', storageNamespace: 'project-a1b2' })).toEqual({
      protocolVersion: 1,
      projectName: 'Example',
      storageNamespace: 'project-a1b2',
    })
    expect(() => decodeProjectContext({ protocolVersion: 2, projectName: 'Example', storageNamespace: 'project-a1b2' })).toThrow(
      'protocolVersion 1',
    )
    expect(() => decodeProjectContext({ protocolVersion: 1, projectName: 'Example', storageNamespace: '' })).toThrow(
      'storageNamespace',
    )
  })
})
