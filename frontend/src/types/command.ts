export type DraftValue = string | number | boolean
export const COMMAND_METADATA_VERSION = 1 as const

export type SchemaPropertyType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export type SchemaProperty = {
  type: SchemaPropertyType
  description?: string
  enum?: Array<string | number | boolean>
  default?: unknown
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minItems?: number
  maxItems?: number
  items?: SchemaProperty
  properties?: Record<string, SchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  xDryRun?: boolean
}

export type CommandSchema = {
  type: 'object'
  properties?: Record<string, SchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export type CommandLoadError = {
  module: string
  error: string
}

export type CommandMetadata = {
  metadataVersion: typeof COMMAND_METADATA_VERSION
  name: string
  description: string
  permission: 'read' | 'write' | 'destructive'
  schema: CommandSchema
  supportsDryRun?: boolean
  category?: string
  icon?: string
  tags?: string[]
  order?: number
  supportedAssetTypes?: string[]
  ui?: Record<string, unknown>
  resultType?: string
  warnings?: string[]
  execution?: {
    thread?: string
    cancellationMode?: string
    timeoutPolicy?: string
  }
}

export type CommandsResult = {
  metadataVersion: typeof COMMAND_METADATA_VERSION
  commands: CommandMetadata[]
  loadErrors: CommandLoadError[]
}

export function getPropertyTypes(property: SchemaProperty) {
  return [property.type]
}

export function propertyHasType(property: SchemaProperty, type: SchemaPropertyType) {
  return property.type === type
}

export function isStructuredProperty(property: SchemaProperty) {
  return propertyHasType(property, 'array') || propertyHasType(property, 'object')
}

export function commandHasDryRun(command: CommandMetadata) {
  return (
    command.supportsDryRun === true ||
    Object.values(command.schema.properties || {}).some((property) => property.xDryRun === true)
  )
}

