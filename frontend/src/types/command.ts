export type DraftValue = string | number | boolean
export type SchemaPropertyType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export type SchemaProperty = {
  type?: SchemaPropertyType | SchemaPropertyType[]
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
  additionalProperties?: boolean | SchemaProperty
  xDryRun?: boolean
}

export type CommandSchema = {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export type CommandMetadata = {
  metadataVersion?: number
  name: string
  description: string
  permission: 'read' | 'write' | 'destructive' | string
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

export function getPropertyTypes(property: SchemaProperty) {
  if (Array.isArray(property.type)) {
    return property.type
  }

  return property.type ? [property.type] : []
}

export function propertyHasType(property: SchemaProperty, type: SchemaPropertyType) {
  return getPropertyTypes(property).includes(type)
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

