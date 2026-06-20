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
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    throw new Error(`${fieldLabel} must be a finite number`)
  }
  if (integer && !Number.isInteger(numericValue)) {
    throw new Error(`${fieldLabel} must be an integer`)
  }

  return numericValue
}

export function hasCommandResult(results: Record<string, unknown>, commandName: string) {
  return Object.prototype.hasOwnProperty.call(results, commandName)
}
