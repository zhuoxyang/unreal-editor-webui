import { describe, expect, it } from 'vitest'
import { resultToJson, resultToMarkdownSummary, rowsToCsv } from './result-export'

describe('result export helpers', () => {
  it('formats JSON with indentation', () => {
    expect(resultToJson({ ok: true })).toContain('"ok": true')
  })

  it('exports CSV with escaped cells', () => {
    expect(rowsToCsv([{ name: 'SM_"Chair"', status: 'changed' }])).toBe(
      '"name","status"\n"SM_""Chair""","changed"',
    )
  })

  it('neutralizes spreadsheet formulas while preserving numeric values', () => {
    expect(rowsToCsv([{
      formula: '=HYPERLINK("https://example.invalid")',
      spaced: '  +SUM(1,1)',
      tabPrefixed: '\tRUN',
      carriageReturnPrefixed: '\rRUN',
      negativeNumber: -5,
    }])).toBe(
      '"formula","spaced","tabPrefixed","carriageReturnPrefixed","negativeNumber"\n' +
      '"\'=HYPERLINK(""https://example.invalid"")","\'  +SUM(1,1)","\'\tRUN","\'\rRUN","-5"',
    )
  })

  it('exports markdown summaries for issues and changes', () => {
    const markdown = resultToMarkdownSummary({
      summary: { issues: 1 },
      issues: [{ severity: 'warning', message: 'Bad name' }],
      changeSet: [{ status: 'changed', before: 'A', after: 'B' }],
    })

    expect(markdown).toContain('**issues**: 1')
    expect(markdown).toContain('warning: Bad name')
    expect(markdown).toContain('changed: A -> B')
  })
})
