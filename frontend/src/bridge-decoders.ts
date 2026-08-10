import { BridgeProtocolError, type BridgeMethodName } from './bridge'
import { parseTaskStatus } from './task-model'
import type {
  NativeToolCatalogDiagnosticCode,
  ProjectContext,
  TaskResult,
  ToolCatalogBridgeResult,
  WebUIDocumentScope,
  WebUIHealth,
  WebUIPythonRuntime,
  WebUISettings,
} from './types/bridge'
import type {
  CommandLoadError,
  CommandMetadata,
  CommandSchema,
  CommandsResult,
  SchemaProperty,
  SchemaPropertyType,
} from './types/command'
import { COMMAND_METADATA_VERSION } from './types/command'

const SCHEMA_PROPERTY_TYPES = new Set<SchemaPropertyType>([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
])
const MAX_SCHEMA_DEPTH = 16
const MAX_DEFAULT_DEPTH = 32
const MAX_DEFAULT_NODES = 10_000
const SUPPORTED_PERMISSIONS = new Set(['read', 'write', 'destructive'])
const TOOL_CATALOG_DIAGNOSTIC_CODES = new Set<NativeToolCatalogDiagnosticCode>([
  'catalog_too_large',
  'catalog_read_failed',
  'catalog_invalid_json',
  'catalog_invalid_encoding',
  'catalog_resource_limit',
  'catalog_invalid_schema_version',
  'catalog_unsupported_version',
])
const WEB_UI_DOCUMENT_SCOPES = new Set<WebUIDocumentScope>([
  'packaged',
  'loopback_http',
  'loopback_https',
  'inactive',
])
const WEB_UI_PYTHON_RUNTIMES = new Set<WebUIPythonRuntime>(['available', 'unavailable'])
const WEB_UI_HEALTH_KEYS = new Set([
  'protocolVersion',
  'bridgeProtocolVersion',
  'pluginVersion',
  'engineVersion',
  'documentScope',
  'pythonRuntime',
  'privilegedConfirmation',
  'taskSessionIsolation',
])
const CANONICAL_PLUGIN_VERSION = /^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/
const CANONICAL_ENGINE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const ROOT_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties'])
const COMMON_PROPERTY_KEYS = ['type', 'description', 'default', 'enum']
const PROPERTY_KEYS_BY_TYPE: Record<SchemaPropertyType, ReadonlySet<string>> = {
  string: new Set([...COMMON_PROPERTY_KEYS, 'minLength', 'maxLength']),
  number: new Set([...COMMON_PROPERTY_KEYS, 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set([...COMMON_PROPERTY_KEYS, 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  boolean: new Set(COMMON_PROPERTY_KEYS),
  array: new Set([...COMMON_PROPERTY_KEYS, 'items', 'minItems', 'maxItems']),
  object: new Set([...COMMON_PROPERTY_KEYS, 'properties', 'required', 'additionalProperties']),
}

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

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function ensureAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  methodName: BridgeMethodName,
  path: string,
) {
  const unsupportedKey = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unsupportedKey) {
    fail(methodName, `field "${path}" contains unsupported keyword "${unsupportedKey}".`)
  }
}

function validateNonNegativeInteger(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
) {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    fail(methodName, `field "${path}" must be a non-negative integer.`)
  }
}

function schemaValueMatchesType(value: unknown, type: SchemaPropertyType) {
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === 'number' && Number.isFinite(value)
}

function validateEnum(
  value: unknown,
  type: SchemaPropertyType,
  methodName: BridgeMethodName,
  path: string,
) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0) {
    fail(methodName, `field "${path}" must be a non-empty array.`)
  }
  if (type === 'array' || type === 'object') {
    fail(methodName, `field "${path}" is only supported for scalar schema types.`)
  }

  const seen = new Set<string>()
  for (const item of value) {
    if (!schemaValueMatchesType(item, type) || (typeof item === 'number' && !Number.isFinite(item))) {
      fail(methodName, `field "${path}" contains a value incompatible with schema type "${type}".`)
    }
    const key = `${typeof item}:${String(item)}`
    if (seen.has(key)) {
      fail(methodName, `field "${path}" must contain unique values.`)
    }
    seen.add(key)
  }
}

type NumericBound = { value: number; exclusive: boolean }

function strongestLowerBound(schema: Record<string, unknown>): NumericBound | undefined {
  const candidates: NumericBound[] = []
  if (typeof schema.minimum === 'number') candidates.push({ value: schema.minimum, exclusive: false })
  if (typeof schema.exclusiveMinimum === 'number') candidates.push({ value: schema.exclusiveMinimum, exclusive: true })
  return candidates.reduce<NumericBound | undefined>((strongest, candidate) => {
    if (!strongest || candidate.value > strongest.value) return candidate
    if (candidate.value === strongest.value && candidate.exclusive) return candidate
    return strongest
  }, undefined)
}

function strongestUpperBound(schema: Record<string, unknown>): NumericBound | undefined {
  const candidates: NumericBound[] = []
  if (typeof schema.maximum === 'number') candidates.push({ value: schema.maximum, exclusive: false })
  if (typeof schema.exclusiveMaximum === 'number') candidates.push({ value: schema.exclusiveMaximum, exclusive: true })
  return candidates.reduce<NumericBound | undefined>((strongest, candidate) => {
    if (!strongest || candidate.value < strongest.value) return candidate
    if (candidate.value === strongest.value && candidate.exclusive) return candidate
    return strongest
  }, undefined)
}

function numericBoundsHaveValue(schema: Record<string, unknown>, type: 'number' | 'integer') {
  const lower = strongestLowerBound(schema)
  const upper = strongestUpperBound(schema)
  if (!lower || !upper) return true

  if (type === 'integer') {
    const first = lower.exclusive ? Math.floor(lower.value) + 1 : Math.ceil(lower.value)
    const last = upper.exclusive ? Math.ceil(upper.value) - 1 : Math.floor(upper.value)
    return first <= last
  }

  return lower.value < upper.value || (
    lower.value === upper.value && !lower.exclusive && !upper.exclusive
  )
}

function validateJsonCompatibleDefault(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
) {
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_DEFAULT_NODES || depth > MAX_DEFAULT_DEPTH) {
      fail(methodName, `field "${path}" exceeds the supported default value complexity.`)
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(methodName, `field "${path}" must contain only finite numbers.`)
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1))
      return
    }
    if (isRecord(current)) {
      Object.values(current).forEach((item) => visit(item, depth + 1))
      return
    }
    fail(methodName, `field "${path}" must be JSON-compatible.`)
  }
  visit(value, 0)
}

function applyDefaultsForValidation(value: unknown, schema: Record<string, unknown>): unknown {
  if (schema.type === 'array' && Array.isArray(value) && isRecord(schema.items)) {
    return value.map((item) => applyDefaultsForValidation(item, schema.items as Record<string, unknown>))
  }
  if (schema.type !== 'object' || !isRecord(value) || !isRecord(schema.properties)) {
    return value
  }

  const result: Record<string, unknown> = { ...value }
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) continue
    if (!hasOwn(result, name) && hasOwn(property, 'default')) {
      result[name] = property.default
    }
    if (hasOwn(result, name)) {
      result[name] = applyDefaultsForValidation(result[name], property)
    }
  }
  return result
}

function validateSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  methodName: BridgeMethodName,
  path: string,
): void {
  const type = schema.type as SchemaPropertyType
  if (!schemaValueMatchesType(value, type)) {
    fail(methodName, `field "${path}" must match schema type "${type}".`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(methodName, `field "${path}" must match its schema enum.`)
  }

  if (typeof value === 'string') {
    const codePointLength = Array.from(value).length
    if (typeof schema.minLength === 'number' && codePointLength < schema.minLength) {
      fail(methodName, `field "${path}" is shorter than minLength.`)
    }
    if (typeof schema.maxLength === 'number' && codePointLength > schema.maxLength) {
      fail(methodName, `field "${path}" is longer than maxLength.`)
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(methodName, `field "${path}" is below minimum.`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(methodName, `field "${path}" is above maximum.`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(methodName, `field "${path}" is not above exclusiveMinimum.`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(methodName, `field "${path}" is not below exclusiveMaximum.`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(methodName, `field "${path}" has fewer than minItems.`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(methodName, `field "${path}" has more than maxItems.`)
    if (isRecord(schema.items)) {
      value.forEach((item, index) => validateSchemaValue(item, schema.items as Record<string, unknown>, methodName, `${path}[${index}]`))
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const name of required) {
      if (typeof name === 'string' && !hasOwn(value, name)) {
        fail(methodName, `field "${path}.${name}" is required by its schema.`)
      }
    }
    for (const [name, item] of Object.entries(value)) {
      const property = properties[name]
      if (isRecord(property)) {
        validateSchemaValue(item, property, methodName, `${path}.${name}`)
      } else if (schema.additionalProperties === false) {
        fail(methodName, `field "${path}" default contains unexpected property "${name}".`)
      }
    }
  }
}

function validateSchemaNode(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
  depth: number,
  root = false,
): asserts value is SchemaProperty {
  if (!isRecord(value)) {
    fail(methodName, `field "${path}" must be an object.`)
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    fail(methodName, `field "${path}" exceeds the supported schema depth.`)
  }

  if (typeof value.type !== 'string' || !SCHEMA_PROPERTY_TYPES.has(value.type as SchemaPropertyType)) {
    fail(methodName, `field "${path}.type" must declare one supported schema type.`)
  }
  const propertyType = value.type as SchemaPropertyType
  if (root && propertyType !== 'object') {
    fail(methodName, `field "${path}.type" must be "object".`)
  }
  const allowedKeys = root ? ROOT_SCHEMA_KEYS : new Set(PROPERTY_KEYS_BY_TYPE[propertyType])
  if (!root && depth === 1) allowedKeys.add('xDryRun')
  ensureAllowedKeys(value, allowedKeys, methodName, path)

  if (!isOptionalString(value.description)) {
    fail(methodName, `field "${path}.description" must be a string.`)
  }
  if (!root) {
    validateEnum(value.enum, propertyType, methodName, `${path}.enum`)
  }

  if (propertyType === 'string') {
    validateNonNegativeInteger(value.minLength, methodName, `${path}.minLength`)
    validateNonNegativeInteger(value.maxLength, methodName, `${path}.maxLength`)
    if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.minLength > value.maxLength) {
      fail(methodName, `field "${path}" has contradictory string length constraints.`)
    }
  }
  if (propertyType === 'number' || propertyType === 'integer') {
    for (const field of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      if (!isOptionalFiniteNumber(value[field])) {
        fail(methodName, `field "${path}.${field}" must be a finite number.`)
      }
    }
    if (!numericBoundsHaveValue(value, propertyType)) {
      fail(methodName, `field "${path}" has contradictory numeric bounds.`)
    }
  }
  if (propertyType === 'array') {
    validateNonNegativeInteger(value.minItems, methodName, `${path}.minItems`)
    validateNonNegativeInteger(value.maxItems, methodName, `${path}.maxItems`)
    if (typeof value.minItems === 'number' && typeof value.maxItems === 'number' && value.minItems > value.maxItems) {
      fail(methodName, `field "${path}" has contradictory array length constraints.`)
    }
    if (value.items === undefined) {
      fail(methodName, `field "${path}.items" is required for array schemas.`)
    }
    validateSchemaNode(value.items, methodName, `${path}.items`, depth + 1)
  }

  if (propertyType === 'object') {
    const properties = value.properties
    if (properties !== undefined && !isRecord(properties)) {
      fail(methodName, `field "${path}.properties" must be an object.`)
    }
    if (isRecord(properties)) {
      for (const [name, property] of Object.entries(properties)) {
        if (!name) fail(methodName, `field "${path}.properties" contains an empty property name.`)
        validateSchemaNode(property, methodName, `${path}.properties.${name}`, depth + 1)
      }
    }
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
      fail(methodName, `field "${path}.additionalProperties" must be a boolean.`)
    }
    if (value.required !== undefined) {
      if (!isStringArray(value.required) || value.required.some((name) => !name)) {
        fail(methodName, `field "${path}.required" must be an array of non-empty strings.`)
      }
      if (new Set(value.required).size !== value.required.length) {
        fail(methodName, `field "${path}.required" must contain unique property names.`)
      }
      for (const requiredName of value.required) {
        if (!isRecord(properties) || !hasOwn(properties, requiredName)) {
          fail(methodName, `field "${path}.required" references unknown property "${requiredName}".`)
        }
      }
    }
  }

  if (value.xDryRun !== undefined) {
    if (depth !== 1 || propertyType !== 'boolean' || typeof value.xDryRun !== 'boolean') {
      fail(methodName, `field "${path}.xDryRun" is only supported as a boolean marker on direct boolean payload properties.`)
    }
  }

  if (!root && hasOwn(value, 'default')) {
    validateJsonCompatibleDefault(value.default, methodName, `${path}.default`)
    validateSchemaValue(
      applyDefaultsForValidation(value.default, value),
      value,
      methodName,
      `${path}.default`,
    )
  }
}

function validateCommandSchema(
  value: unknown,
  methodName: BridgeMethodName,
  path: string,
): asserts value is CommandSchema {
  validateSchemaNode(value, methodName, path, 0, true)
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
  if (typeof value.permission !== 'string' || !SUPPORTED_PERMISSIONS.has(value.permission)) {
    fail(methodName, `field "${path}.permission" must be read, write, or destructive.`)
  }
  if (value.metadataVersion !== COMMAND_METADATA_VERSION) {
    fail(methodName, `field "${path}.metadataVersion" must be ${COMMAND_METADATA_VERSION}.`)
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
  if (!isOptionalFiniteNumber(value.order)) {
    fail(methodName, `field "${path}.order" must be a finite number.`)
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

function decodeCommandLoadErrors(value: unknown, methodName: BridgeMethodName): CommandLoadError[] {
  if (!Array.isArray(value)) {
    fail(methodName, 'field "loadErrors" must be an array.')
  }
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.module !== 'string' || !item.module.trim()) {
      fail(methodName, `field "loadErrors[${index}].module" must be a non-empty string.`)
    }
    if (typeof item.error !== 'string' || !item.error.trim()) {
      fail(methodName, `field "loadErrors[${index}].error" must be a non-empty string.`)
    }
    return { module: item.module, error: item.error }
  })
}

function commandDiagnosticModule(value: unknown, index: number) {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim()
    ? value.name
    : `commands[${index}]`
}

function commandDiagnosticMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Invalid command metadata.'
}

export function decodeCommandsResult(value: unknown): CommandsResult {
  const methodName: BridgeMethodName = 'executecommand'
  if (!isRecord(value)) {
    fail(methodName, 'must be an object.')
  }
  if (value.metadataVersion !== COMMAND_METADATA_VERSION) {
    fail(methodName, `requires metadataVersion ${COMMAND_METADATA_VERSION}.`)
  }
  if (!Array.isArray(value.commands)) {
    fail(methodName, 'must contain a commands array.')
  }

  const commands: CommandMetadata[] = []
  const loadErrors = decodeCommandLoadErrors(value.loadErrors, methodName)
  const names = new Set<string>()
  for (let index = 0; index < value.commands.length; index += 1) {
    const command = value.commands[index]
    try {
      validateCommandMetadata(command, methodName, index)
      if (names.has(command.name)) {
        loadErrors.push({
          module: command.name,
          error: `Duplicate command name "${command.name}" was ignored.`,
        })
        continue
      }
      names.add(command.name)
      commands.push(command)
    } catch (error) {
      loadErrors.push({
        module: commandDiagnosticModule(command, index),
        error: commandDiagnosticMessage(error),
      })
    }
  }
  return {
    metadataVersion: COMMAND_METADATA_VERSION,
    commands,
    loadErrors,
  }
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

export function decodeWebUIHealth(value: unknown): WebUIHealth {
  const methodName: BridgeMethodName = 'getwebuihealth'
  if (!isRecord(value)) {
    fail(methodName, 'must be an object.')
  }

  ensureAllowedKeys(value, WEB_UI_HEALTH_KEYS, methodName, 'health')
  for (const key of WEB_UI_HEALTH_KEYS) {
    if (!hasOwn(value, key)) {
      fail(methodName, `is missing field "${key}".`)
    }
  }

  if (value.protocolVersion !== 1) {
    fail(methodName, 'requires protocolVersion 1.')
  }
  if (value.bridgeProtocolVersion !== 1) {
    fail(methodName, 'requires bridgeProtocolVersion 1.')
  }
  if (
    typeof value.pluginVersion !== 'string'
    || value.pluginVersion.length === 0
    || value.pluginVersion.length > 64
    || !CANONICAL_PLUGIN_VERSION.test(value.pluginVersion)
  ) {
    fail(methodName, 'requires a canonical pluginVersion of at most 64 alphanumeric dot-or-hyphen segments.')
  }
  if (
    typeof value.engineVersion !== 'string'
    || value.engineVersion.length > 32
    || !CANONICAL_ENGINE_VERSION.test(value.engineVersion)
  ) {
    fail(methodName, 'requires engineVersion in canonical major.minor.patch form.')
  }
  if (
    typeof value.documentScope !== 'string'
    || !WEB_UI_DOCUMENT_SCOPES.has(value.documentScope as WebUIDocumentScope)
  ) {
    fail(methodName, 'requires a supported documentScope.')
  }
  if (
    typeof value.pythonRuntime !== 'string'
    || !WEB_UI_PYTHON_RUNTIMES.has(value.pythonRuntime as WebUIPythonRuntime)
  ) {
    fail(methodName, 'requires pythonRuntime available or unavailable.')
  }
  if (value.privilegedConfirmation !== 'per_call') {
    fail(methodName, 'requires privilegedConfirmation per_call.')
  }
  if (value.taskSessionIsolation !== 'document') {
    fail(methodName, 'requires taskSessionIsolation document.')
  }

  return {
    protocolVersion: 1,
    bridgeProtocolVersion: 1,
    pluginVersion: value.pluginVersion,
    engineVersion: value.engineVersion,
    documentScope: value.documentScope as WebUIDocumentScope,
    pythonRuntime: value.pythonRuntime as WebUIPythonRuntime,
    privilegedConfirmation: 'per_call',
    taskSessionIsolation: 'document',
  }
}

export function decodeToolCatalogBridgeResult(value: unknown): ToolCatalogBridgeResult {
  const methodName: BridgeMethodName = 'gettoolcatalog'
  if (!isRecord(value)) {
    fail(methodName, 'must be an object.')
  }
  ensureAllowedKeys(
    value,
    new Set(['protocolVersion', 'source', 'catalog', 'diagnosticCode']),
    methodName,
    'catalog transport',
  )
  for (const key of ['protocolVersion', 'source', 'catalog', 'diagnosticCode']) {
    if (!hasOwn(value, key)) {
      fail(methodName, `is missing field "${key}".`)
    }
  }
  if (value.protocolVersion !== 1) {
    fail(methodName, 'requires protocolVersion 1.')
  }

  if (value.source === 'project') {
    if (!isRecord(value.catalog) || value.diagnosticCode !== null) {
      fail(methodName, 'project source requires an object catalog and null diagnosticCode.')
    }
    return value as ToolCatalogBridgeResult
  }
  if (value.source === 'missing') {
    if (value.catalog !== null || value.diagnosticCode !== null) {
      fail(methodName, 'missing source requires null catalog and diagnosticCode.')
    }
    return value as ToolCatalogBridgeResult
  }
  if (value.source === 'invalid') {
    if (
      value.catalog !== null
      || typeof value.diagnosticCode !== 'string'
      || !TOOL_CATALOG_DIAGNOSTIC_CODES.has(value.diagnosticCode as NativeToolCatalogDiagnosticCode)
    ) {
      fail(methodName, 'invalid source requires null catalog and a supported diagnosticCode.')
    }
    return value as ToolCatalogBridgeResult
  }

  fail(methodName, 'requires source project, missing, or invalid.')
}
