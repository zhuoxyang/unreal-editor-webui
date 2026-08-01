import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

  it('copies asset paths from asset table actions', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <ResultRenderer
        result={{ assets: [{ assetName: 'SM_Chair', objectPath: '/Game/SM_Chair' }] }}
        resultType="assetTable"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))

    expect(writeText).toHaveBeenCalledWith('/Game/SM_Chair')
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

  it('bounds large tables and pages through results', () => {
    const assets = Array.from({ length: 120 }, (_, index) => ({ assetName: `Asset-${index}` }))
    render(<ResultRenderer result={{ assets }} resultType="assetTable" />)

    expect(screen.getByText('Asset-0')).toBeInTheDocument()
    expect(screen.queryByText('Asset-50')).not.toBeInTheDocument()
    expect(screen.getByText('Rows 1–50 of 120')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Asset-50')).toBeInTheDocument()
    expect(screen.queryByText('Asset-0')).not.toBeInTheDocument()
  })

  it('truncates oversized JSON previews', () => {
    render(<ResultRenderer result={{ value: 'x'.repeat(110_000) }} resultType="json" />)
    expect(screen.getByText(/JSON preview truncated/)).toBeInTheDocument()
  })
})
