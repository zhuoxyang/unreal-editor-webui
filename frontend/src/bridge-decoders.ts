import { BridgeProtocolError, type BridgeMethodName } from './bridge'
import { parseTaskStatus } from './task-model'
import type { ProjectContext, TaskResult, WebUISettings } from './types/bridge'
import type {
  CommandMetadata,
  CommandSchema,
  SchemaProperty,
  SchemaPropertyType,
} from './types/command'

const SCHEMA_PROPERTY_TYPES = new Set<SchemaPropertyType>([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
])
const MAX_SCHEMA_DEPTH = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(methodName: BridgeMethodName, message: string): never {
  throw new BridgeProtocolError(methodName, `result ${message}`)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function validateSchemaProperty(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
  depth: number,
): asserts value is SchemaProperty {
  if (!isRecord(value)) {
    fail(methodName, `field "${path}" must be an object.`)
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    fail(methodName, `field "${path}" exceeds the supported schema depth.`)
  }

  const propertyTypes = Array.isArray(value.type) ? value.type : value.type === undefined ? [] : [value.type]
  if (propertyTypes.some((item) => typeof item !== 'string' || !SCHEMA_PROPERTY_TYPES.has(item as SchemaPropertyType))) {
    fail(methodName, `field "${path}.type" contains an unsupported value.`)
  }
  if (!isOptionalString(value.description)) {
    fail(methodName, `field "${path}.description" must be a string.`)
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || value.enum.some((item) => !['string', 'number', 'boolean'].includes(typeof item)))
  ) {
    fail(methodName, `field "${path}.enum" must contain only scalar values.`)
  }
  for (const field of ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems']) {
    if (!isOptionalFiniteNumber(value[field])) {
      fail(methodName, `field "${path}.${field}" must be a finite number.`)
    }
  }
  if (value.required !== undefined && !isStringArray(value.required)) {
    fail(methodName, `field "${path}.required" must be an array of strings.`)
  }
  if (value.xDryRun !== undefined && typeof value.xDryRun !== 'boolean') {
    fail(methodName, `field "${path}.xDryRun" must be a boolean.`)
  }
  if (value.items !== undefined) {
    validateSchemaProperty(value.items, methodName, `${path}.items`, depth + 1)
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      fail(methodName, `field "${path}.properties" must be an object.`)
    }
    for (const [name, property] of Object.entries(value.properties)) {
      validateSchemaProperty(property, methodName, `${path}.properties.${name}`, depth + 1)
    }
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    validateSchemaProperty(value.additionalProperties, methodName, `${path}.additionalProperties`, depth + 1)
  }
}

function validateCommandSchema(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
): asserts value is CommandSchema {
  if (!isRecord(value)) {
    fail(methodName, `field "${path}" must be an object.`)
  }
  if (!isOptionalString(value.type)) {
    fail(methodName, `field "${path}.type" must be a string.`)
  }
  if (value.required !== undefined && !isStringArray(value.required)) {
    fail(methodName, `field "${path}.required" must be an array of strings.`)
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    fail(methodName, `field "${path}.additionalProperties" must be a boolean.`)
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      fail(methodName, `field "${path}.properties" must be an object.`)
    }
    for (const [name, property] of Object.entries(value.properties)) {
      validateSchemaProperty(property, methodName, `${path}.properties.${name}`, 1)
    }
  }
}

function validateCommandMetadata(
  value: unknown,
  methodName: BridgeMethodName,
  index: number,
): asserts value is CommandMetadata {
  const path = `commands[${index}]`
  if (!isRecord(value)) {
    fail(methodName, `field "${path}" must be an object.`)
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    fail(methodName, `field "${path}.name" must be a non-empty string.`)
  }
  if (typeof value.description !== 'string') {
    fail(methodName, `field "${path}.description" must be a string.`)
  }
  if (typeof value.permission !== 'string' || !value.permission.trim()) {
    fail(methodName, `field "${path}.permission" must be a non-empty string.`)
  }
  validateCommandSchema(value.schema, methodName, `${path}.schema`)

  for (const field of ['category', 'icon', 'resultType']) {
    if (!isOptionalString(value[field])) {
      fail(methodName, `field "${path}.${field}" must be a string.`)
    }
  }
  for (const field of ['tags', 'supportedAssetTypes', 'warnings']) {
    if (value[field] !== undefined && !isStringArray(value[field])) {
      fail(methodName, `field "${path}.${field}" must be an array of strings.`)
    }
  }
  if (!isOptionalFiniteNumber(value.metadataVersion) || !isOptionalFiniteNumber(value.order)) {
    fail(methodName, `field "${path}" contains invalid numeric metadata.`)
  }
  if (value.supportsDryRun !== undefined && typeof value.supportsDryRun !== 'boolean') {
    fail(methodName, `field "${path}.supportsDryRun" must be a boolean.`)
  }
  if (value.ui !== undefined && !isRecord(value.ui)) {
    fail(methodName, `field "${path}.ui" must be an object.`)
  }
  if (value.execution !== undefined) {
    if (!isRecord(value.execution)) {
      fail(methodName, `field "${path}.execution" must be an object.`)
    }
    for (const field of ['thread', 'cancellationMode', 'timeoutPolicy']) {
      if (!isOptionalString(value.execution[field])) {
        fail(methodName, `field "${path}.execution.${field}" must be a string.`)
      }
    }
  }
}

export function decodeCommandsResult(value: unknown): { commands: CommandMetadata[] } {
  const methodName: BridgeMethodName = 'executecommand'
  if (!isRecord(value) || !Array.isArray(value.commands)) {
    fail(methodName, 'must contain a commands array.')
  }

  const names = new Set<string>()
  for (let index = 0; index < value.commands.length; index += 1) {
    const command = value.commands[index]
    validateCommandMetadata(command, methodName, index)
    if (names.has(command.name)) {
      fail(methodName, `contains duplicate command name "${command.name}".`)
    }
    names.add(command.name)
  }
  return value as { commands: CommandMetadata[] }
}

export function decodeTaskResult(
  methodName: 'startcommand' | 'gettask' | 'canceltask',
  value: unknown,
  expectedTaskId?: string,
): TaskResult {
  if (!isRecord(value) || typeof value.taskId !== 'string' || !value.taskId.trim()) {
    fail(methodName, 'requires a non-empty taskId string.')
  }
  if (typeof value.status !== 'string' || !parseTaskStatus(value.status)) {
    fail(methodName, 'requires a supported task status.')
  }
  if (expectedTaskId !== undefined && value.taskId !== expectedTaskId) {
    fail(methodName, `returned taskId "${value.taskId}" instead of "${expectedTaskId}".`)
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    fail(methodName, 'field "payload" must be an object.')
  }
  if (
    value.progress !== undefined &&
    (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100)
  ) {
    fail(methodName, 'field "progress" must be a finite number from 0 to 100.')
  }
  if (value.cancellable !== undefined && typeof value.cancellable !== 'boolean') {
    fail(methodName, 'field "cancellable" must be a boolean.')
  }
  if (value.logs !== undefined && !isStringArray(value.logs)) {
    fail(methodName, 'field "logs" must be an array of strings.')
  }
  for (const field of [
    'command',
    'cancellationMode',
    'executionThread',
    'timeoutPolicy',
    'message',
    'createdAt',
    'updatedAt',
    'responseJson',
  ]) {
    if (!isOptionalString(value[field])) {
      fail(methodName, `field "${field}" must be a string.`)
    }
  }
  return value as TaskResult
}

export function decodeTaskListResult(value: unknown): TaskResult[] {
  const methodName: BridgeMethodName = 'listtasks'
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    fail(methodName, 'must contain a tasks array.')
  }

  const taskIds = new Set<string>()
  return value.tasks.map((task, index) => {
    let decoded: TaskResult
    try {
      decoded = decodeTaskResult('gettask', task)
    } catch (error) {
      if (error instanceof BridgeProtocolError) {
        fail(methodName, `contains an invalid task at index ${index}: ${error.message}`)
      }
      throw error
    }
    if (taskIds.has(decoded.taskId)) {
      fail(methodName, `contains duplicate task id "${decoded.taskId}".`)
    }
    taskIds.add(decoded.taskId)
    return decoded
  })
}

export function decodeRemoveTaskResult(value: unknown, expectedTaskId: string): { taskId: string; removed: boolean } {
  const methodName: BridgeMethodName = 'removetask'
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId !== expectedTaskId) {
    fail(methodName, `requires taskId "${expectedTaskId}".`)
  }
  if (typeof value.removed !== 'boolean') {
    fail(methodName, 'requires a boolean removed field.')
  }
  return value as { taskId: string; removed: boolean }
}

export function decodeWebUISettings(
  methodName: 'getwebuisettings' | 'setwebuisettings',
  value: unknown,
): WebUISettings {
  if (!isRecord(value) || typeof value.useDevServer !== 'boolean') {
    fail(methodName, 'requires a boolean useDevServer field.')
  }
  for (const field of ['devServerUrl', 'startupUrl', 'resolvedUrl']) {
    if (typeof value[field] !== 'string') {
      fail(methodName, `field "${field}" must be a string.`)
    }
  }
  return value as WebUISettings
}

export function decodeProjectContext(value: unknown): ProjectContext {
  const methodName: BridgeMethodName = 'getprojectcontext'
  if (!isRecord(value) || value.protocolVersion !== 1) {
    fail(methodName, 'requires protocolVersion 1.')
  }
  if (typeof value.projectName !== 'string' || !value.projectName.trim()) {
    fail(methodName, 'requires a non-empty projectName string.')
  }
  if (
    typeof value.storageNamespace !== 'string' ||
    !value.storageNamespace.trim() ||
    value.storageNamespace.length > 128
  ) {
    fail(methodName, 'requires a non-empty storageNamespace string no longer than 128 characters.')
  }
  return value as ProjectContext
}
