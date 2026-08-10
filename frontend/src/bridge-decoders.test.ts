import { describe, expect, it } from 'vitest'
import schemaContract from '../../tests/fixtures/command-schema-v1.json'
import {
  decodeCommandsResult,
  decodeProjectContext,
  decodeRemoveTaskResult,
  decodeTaskListResult,
  decodeTaskResult,
  decodeToolCatalogBridgeResult,
  decodeWebUIHealth,
  decodeWebUISettings,
} from './bridge-decoders'

const command = {
  metadataVersion: 1,
  name: 'asset.scan',
  description: 'Scan assets.',
  permission: 'read',
  schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } },
}

function commandCatalogue(commands: unknown[], loadErrors: unknown[] = []) {
  return {
    metadataVersion: 1,
    commands,
    loadErrors,
  }
}

describe('bridge result decoders', () => {
  it('accepts a v1 catalogue and preserves registry load diagnostics', () => {
    const decoded = decodeCommandsResult(commandCatalogue(
      [command],
      [{ module: 'plugin.optional', error: 'optional dependency unavailable' }],
    ))

    expect(decoded.commands).toHaveLength(1)
    expect(decoded.loadErrors).toEqual([
      { module: 'plugin.optional', error: 'optional dependency unavailable' },
    ])
  })

  it('isolates malformed and duplicate commands without dropping healthy commands', () => {
    const decoded = decodeCommandsResult(commandCatalogue([
      command,
      { ...command, name: 'asset.invalid', schema: null },
      command,
    ]))

    expect(decoded.commands.map((item) => item.name)).toEqual(['asset.scan'])
    expect(decoded.loadErrors.map((item) => item.module)).toEqual(['asset.invalid', 'asset.scan'])
    expect(decoded.loadErrors[0].error).toContain('commands[1].schema')
    expect(decoded.loadErrors[1].error).toContain('Duplicate command name')
  })

  it('rejects incompatible catalogue envelopes', () => {
    expect(() => decodeCommandsResult({ ...commandCatalogue([command]), metadataVersion: 2 })).toThrow(
      'metadataVersion 1',
    )
    expect(() => decodeCommandsResult({ ...commandCatalogue([command]), loadErrors: null })).toThrow(
      'loadErrors',
    )
    expect(() => decodeCommandsResult(commandCatalogue([command], [{ module: '', error: 'broken' }]))).toThrow(
      'loadErrors[0].module',
    )
  })

  it('consumes the shared command schema v1 contract fixtures', () => {
    expect(schemaContract.metadataVersion).toBe(1)

    for (const fixture of schemaContract.valid) {
      const decoded = decodeCommandsResult(commandCatalogue([{
        ...command,
        name: fixture.name,
        schema: fixture.schema,
      }]))
      expect(decoded.commands, fixture.name).toHaveLength(1)
      expect(decoded.loadErrors, fixture.name).toEqual([])
    }

    for (const fixture of schemaContract.invalid) {
      const decoded = decodeCommandsResult(commandCatalogue([{
        ...command,
        name: fixture.name,
        schema: fixture.schema,
      }]))
      expect(decoded.commands, fixture.name).toEqual([])
      expect(decoded.loadErrors, fixture.name).toHaveLength(1)
      expect(decoded.loadErrors[0].error, fixture.name).toContain(fixture.errorContains)
    }
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

  it('strictly validates the Web UI health v1 result', () => {
    const health = {
      protocolVersion: 1,
      bridgeProtocolVersion: 1,
      pluginVersion: '0.1.1',
      engineVersion: '5.8.0',
      documentScope: 'packaged',
      pythonRuntime: 'available',
      privilegedConfirmation: 'per_call',
      taskSessionIsolation: 'document',
    }

    expect(decodeWebUIHealth(health)).toEqual(health)
    expect(() => decodeWebUIHealth({ ...health, protocolVersion: 2 })).toThrow('protocolVersion 1')
    expect(() => decodeWebUIHealth({ ...health, bridgeProtocolVersion: 2 })).toThrow('bridgeProtocolVersion 1')
    expect(() => decodeWebUIHealth({ ...health, resolvedUrl: 'file:///C:/Users/private/index.html' })).toThrow(
      'unsupported keyword "resolvedUrl"',
    )
    const missingPythonRuntime: Record<string, unknown> = { ...health }
    delete missingPythonRuntime.pythonRuntime
    expect(() => decodeWebUIHealth(missingPythonRuntime)).toThrow('missing field "pythonRuntime"')
  })

  it.each([
    ['pluginVersion', '', 'canonical pluginVersion'],
    ['pluginVersion', '0.1.1_secret', 'canonical pluginVersion'],
    ['pluginVersion', '0..1', 'canonical pluginVersion'],
    ['pluginVersion', `1.${'2'.repeat(64)}`, 'canonical pluginVersion'],
    ['engineVersion', '5.8', 'major.minor.patch'],
    ['engineVersion', '05.8.0', 'major.minor.patch'],
    ['documentScope', 'remote', 'supported documentScope'],
    ['pythonRuntime', 'unknown', 'pythonRuntime available or unavailable'],
    ['privilegedConfirmation', 'once', 'privilegedConfirmation per_call'],
    ['taskSessionIsolation', 'global', 'taskSessionIsolation document'],
  ])('rejects an invalid Web UI health %s value', (field, value, expectedMessage) => {
    expect(() => decodeWebUIHealth({
      protocolVersion: 1,
      bridgeProtocolVersion: 1,
      pluginVersion: '0.1.1',
      engineVersion: '5.8.0',
      documentScope: 'loopback_https',
      pythonRuntime: 'unavailable',
      privilegedConfirmation: 'per_call',
      taskSessionIsolation: 'document',
      [field]: value,
    })).toThrow(expectedMessage)
  })

  it('strictly validates native tool catalog transport envelopes', () => {
    const projectCatalog = { schemaVersion: 1 }
    expect(decodeToolCatalogBridgeResult({
      protocolVersion: 1,
      source: 'project',
      catalog: projectCatalog,
      diagnosticCode: null,
    })).toMatchObject({ source: 'project', catalog: projectCatalog })
    expect(decodeToolCatalogBridgeResult({
      protocolVersion: 1,
      source: 'missing',
      catalog: null,
      diagnosticCode: null,
    })).toMatchObject({ source: 'missing' })

    for (const diagnosticCode of [
      'catalog_too_large',
      'catalog_read_failed',
      'catalog_invalid_json',
      'catalog_invalid_encoding',
      'catalog_resource_limit',
      'catalog_invalid_schema_version',
      'catalog_unsupported_version',
    ]) {
      expect(decodeToolCatalogBridgeResult({
        protocolVersion: 1,
        source: 'invalid',
        catalog: null,
        diagnosticCode,
      })).toMatchObject({ source: 'invalid', diagnosticCode })
    }

    expect(() => decodeToolCatalogBridgeResult({
      protocolVersion: 1,
      source: 'project',
      catalog: projectCatalog,
      diagnosticCode: null,
      path: 'C:/private/project',
    })).toThrow('unsupported keyword')
    expect(() => decodeToolCatalogBridgeResult({
      protocolVersion: 1,
      source: 'invalid',
      catalog: null,
      diagnosticCode: 'catalog_unknown',
    })).toThrow('supported diagnosticCode')
  })
})
