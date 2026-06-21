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
