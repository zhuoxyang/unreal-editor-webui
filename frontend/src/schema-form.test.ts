import { describe, expect, it } from 'vitest'
import {
  decodeEnumOption,
  encodeEnumOption,
  hasCommandResult,
  parseNumericDraft,
  validateNumericConstraints,
} from './schema-form'

describe('schema form coercion', () => {
  it.each([['text'], [7], [true], [false]])('preserves enum value type for %j', (value) => {
    expect(decodeEnumOption(encodeEnumOption(value))).toBe(value)
  })

  it('rejects non-finite numbers and fractional integers', () => {
    expect(() => parseNumericDraft('', false, 'field')).toThrow('field is required')
    expect(() => parseNumericDraft('   ', false, 'field')).toThrow('field is required')
    expect(() => parseNumericDraft('Infinity', false, 'field')).toThrow('finite number')
    expect(() => parseNumericDraft('1.5', true, 'field')).toThrow('integer')
    expect(parseNumericDraft('1.5', false, 'field')).toBe(1.5)
  })

  it('enforces inclusive and exclusive numeric constraints', () => {
    expect(() => validateNumericConstraints(0, { minimum: 1 }, 'field')).toThrow('greater than or equal to 1')
    expect(() => validateNumericConstraints(2, { maximum: 1 }, 'field')).toThrow('less than or equal to 1')
    expect(() => validateNumericConstraints(1, { exclusiveMinimum: 1 }, 'field')).toThrow('greater than 1')
    expect(() => validateNumericConstraints(1, { exclusiveMaximum: 1 }, 'field')).toThrow('less than 1')
    expect(validateNumericConstraints(1, { minimum: 1, maximum: 1 }, 'field')).toBe(1)
  })

  it('recognizes stored falsy results', () => {
    expect(hasCommandResult({ falseResult: false, zeroResult: 0 }, 'falseResult')).toBe(true)
    expect(hasCommandResult({ falseResult: false, zeroResult: 0 }, 'zeroResult')).toBe(true)
  })
})
