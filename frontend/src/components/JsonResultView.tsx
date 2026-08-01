type JsonResultViewProps = {
  result: unknown
}

const MAX_JSON_PREVIEW_LENGTH = 100_000
const MAX_JSON_PREVIEW_NODES = 500
const MAX_JSON_PREVIEW_ITEMS = 100
const MAX_JSON_PREVIEW_DEPTH = 8
const MAX_JSON_PREVIEW_STRING = 2_000

type PreviewBudget = {
  nodes: number
  truncated: boolean
}

function boundedJsonValue(value: unknown, budget: PreviewBudget, depth = 0): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_JSON_PREVIEW_NODES || depth > MAX_JSON_PREVIEW_DEPTH) {
    budget.truncated = true
    return '…'
  }
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_PREVIEW_STRING) {
      budget.truncated = true
      return `${value.slice(0, MAX_JSON_PREVIEW_STRING)}…`
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_PREVIEW_ITEMS) {
      budget.truncated = true
    }
    return value.slice(0, MAX_JSON_PREVIEW_ITEMS).map((item) => boundedJsonValue(item, budget, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    const preview: Record<string, unknown> = {}
    let count = 0
    for (const [key, item] of Object.entries(value)) {
      if (count >= MAX_JSON_PREVIEW_ITEMS) {
        budget.truncated = true
        break
      }
      preview[key] = boundedJsonValue(item, budget, depth + 1)
      count += 1
    }
    return preview
  }
  return value
}

export function JsonResultView({ result }: JsonResultViewProps) {
  const budget: PreviewBudget = { nodes: 0, truncated: false }
  const boundedValue = boundedJsonValue(result, budget)
  const serialized = JSON.stringify(boundedValue, null, 2) ?? String(boundedValue)
  const truncated = budget.truncated || serialized.length > MAX_JSON_PREVIEW_LENGTH
  const preview = serialized.length > MAX_JSON_PREVIEW_LENGTH
    ? `${serialized.slice(0, MAX_JSON_PREVIEW_LENGTH)}\n…`
    : serialized

  return (
    <div className="result-view">
      {truncated ? (
        <p className="muted" role="status">
          JSON preview truncated at {MAX_JSON_PREVIEW_LENGTH.toLocaleString()} characters. Use the JSON export for the full result.
        </p>
      ) : null}
      <pre>{preview}</pre>
    </div>
  )
}
