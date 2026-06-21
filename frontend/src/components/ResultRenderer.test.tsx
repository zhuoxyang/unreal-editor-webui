import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResultRenderer } from './ResultRenderer'

describe('ResultRenderer', () => {
  it('renders asset tables from command result metadata', () => {
    render(
      <ResultRenderer
        result={{ assets: [{ assetName: 'SM_Chair', objectPath: '/Game/SM_Chair' }] }}
        resultType="assetTable"
      />,
    )

    expect(screen.getByText('assetName')).toBeInTheDocument()
    expect(screen.getByText('SM_Chair')).toBeInTheDocument()
  })

  it('renders change sets from protocol envelopes', () => {
    render(
      <ResultRenderer
        result={{
          protocolVersion: 1,
          view: 'changeSet',
          summary: { changed: 1 },
          changeSet: [{ status: 'changed', action: 'rename', assetPath: '/Game/A', before: '/Game/A', after: '/Game/B' }],
        }}
      />,
    )

    expect(screen.getByText('changed')).toBeInTheDocument()
    expect(screen.getByText('/Game/B')).toBeInTheDocument()
  })

  it('falls back to JSON for unknown result types', () => {
    render(<ResultRenderer result={{ value: false }} resultType="unknown" />)

    expect(screen.getByText(/"value": false/)).toBeInTheDocument()
  })
})
