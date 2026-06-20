import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JsonResultView } from './JsonResultView'

describe('JsonResultView', () => {
  it.each([[false, 'false'], [0, '0']])('renders the falsy result %j', (result, expected) => {
    render(<JsonResultView result={result} />)
    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})
