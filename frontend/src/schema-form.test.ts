import { describe, expect, it } from 'vitest'
import {
  decodeEnumOption,
  encodeEnumOption,
  hasCommandResult,
  parseNumericDraft,
} from './schema-form'

describe('schema form coercion', () => {
  it.each([['text'], [7], [true], [false]])('preserves enum value type for %j', (value) => {
    expect(decodeEnumOption(encodeEnumOption(value))).toBe(value)
  })

  it('rejects non-finite numbers and fractional integers', () => {
    expect(() => parseNumericDraft('Infinity', false, 'field')).toThrow('finite number')
    expect(() => parseNumericDraft('1.5', true, 'field')).toThrow('integer')
    expect(parseNumericDraft('1.5', false, 'field')).toBe(1.5)
  })

  it('recognizes stored falsy results', () => {
    expect(hasCommandResult({ falseResult: false, zeroResult: 0 }, 'falseResult')).toBe(true)
    expect(hasCommandResult({ falseResult: false, zeroResult: 0 }, 'zeroResult')).toBe(true)
  })
})
