export type SchemaScalar = string | number | boolean

export function isSchemaScalar(value: unknown): value is SchemaScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function encodeEnumOption(value: SchemaScalar) {
  return JSON.stringify({ value })
}

export function decodeEnumOption(serialized: string): SchemaScalar {
  const parsed = JSON.parse(serialized) as { value?: unknown }
  if (!parsed || !isSchemaScalar(parsed.value)) {
    throw new Error('Enum option must contain a string, number, or boolean value.')
  }

  return parsed.value
}

export function parseNumericDraft(value: string | number | boolean, integer: boolean, fieldLabel: string) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${fieldLabel} is required`)
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    throw new Error(`${fieldLabel} must be a finite number`)
  }
  if (integer && !Number.isInteger(numericValue)) {
    throw new Error(`${fieldLabel} must be an integer`)
  }

  return numericValue
}

export type NumericConstraints = {
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}

export function validateNumericConstraints(
  value: number,
  constraints: NumericConstraints,
  fieldLabel: string,
) {
  if (typeof constraints.minimum === 'number' && value < constraints.minimum) {
    throw new Error(`${fieldLabel} must be greater than or equal to ${constraints.minimum}`)
  }
  if (typeof constraints.maximum === 'number' && value > constraints.maximum) {
    throw new Error(`${fieldLabel} must be less than or equal to ${constraints.maximum}`)
  }
  if (typeof constraints.exclusiveMinimum === 'number' && value <= constraints.exclusiveMinimum) {
    throw new Error(`${fieldLabel} must be greater than ${constraints.exclusiveMinimum}`)
  }
  if (typeof constraints.exclusiveMaximum === 'number' && value >= constraints.exclusiveMaximum) {
    throw new Error(`${fieldLabel} must be less than ${constraints.exclusiveMaximum}`)
  }

  return value
}

export function hasCommandResult(results: Record<string, unknown>, commandName: string) {
  return Object.prototype.hasOwnProperty.call(results, commandName)
}
