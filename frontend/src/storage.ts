export type StorageLoadSource = 'missing' | 'current' | 'legacy' | 'invalid' | 'unsupported'

export type StorageLoadResult<T> = {
  value: T
  needsRewrite: boolean
  source: StorageLoadSource
}

export type StoredEnvelope<T> = {
  schemaVersion: number
  data: T
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function storedEnvelope<T>(schemaVersion: number, data: T): StoredEnvelope<T> {
  return {
    schemaVersion,
    data,
  }
}
