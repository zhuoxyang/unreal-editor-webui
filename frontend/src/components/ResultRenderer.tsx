import { JsonResultView } from './JsonResultView'

type ResultEnvelope = {
  protocolVersion?: number
  view?: string
  summary?: Record<string, unknown>
  data?: unknown
  issues?: IssueRow[]
  changeSet?: ChangeOperation[]
  assets?: unknown[]
}

type IssueRow = {
  severity?: string
  assetPath?: string
  propertyPath?: string
  message?: string
  suggestedAction?: string
  documentation?: string
}

type ChangeOperation = {
  assetPath?: string
  propertyPath?: string
  before?: unknown
  after?: unknown
  action?: string
  status?: string
  message?: string
}

type ResultRendererProps = {
  result: unknown
  commandName?: string
  resultType?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function viewForResult(result: unknown, resultType?: string) {
  if (isRecord(result) && typeof result.view === 'string') {
    return result.view
  }

  if (resultType) {
    return resultType
  }

  return 'json'
}

function toEnvelope(result: unknown): ResultEnvelope {
  return isRecord(result) ? (result as ResultEnvelope) : {}
}

function formatCell(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return '-'
  }

  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value)
}

function AssetTableView({ result }: { result: unknown }) {
  const envelope = toEnvelope(result)
  const assets = Array.isArray(envelope.assets) ? envelope.assets : []

  if (assets.length === 0) {
    return <JsonResultView result={result} />
  }

  const columns = Array.from(new Set(assets.flatMap((asset) => (isRecord(asset) ? Object.keys(asset) : []))))

  return (
    <div className="result-view">
      <div className="result-summary">
        {typeof envelope.summary === 'object' ? JSON.stringify(envelope.summary) : `${assets.length} assets`}
      </div>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assets.map((asset, index) => (
            <tr key={isRecord(asset) ? String(asset.objectPath || asset.path || asset.assetName || index) : index}>
              {columns.map((column) => (
                <td key={column}>{formatCell(isRecord(asset) ? asset[column] : '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IssueTableView({ result }: { result: unknown }) {
  const envelope = toEnvelope(result)
  const issues = Array.isArray(envelope.issues) ? envelope.issues : []

  if (issues.length === 0) {
    return <JsonResultView result={result} />
  }

  return (
    <div className="result-view">
      <div className="result-summary">{issues.length} issues</div>
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Asset</th>
            <th>Property</th>
            <th>Message</th>
            <th>Suggested Action</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${issue.assetPath || 'issue'}-${issue.propertyPath || index}`}>
              <td>{formatCell(issue.severity)}</td>
              <td>{formatCell(issue.assetPath)}</td>
              <td>{formatCell(issue.propertyPath)}</td>
              <td>{formatCell(issue.message)}</td>
              <td>{formatCell(issue.suggestedAction)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChangeSetView({ result }: { result: unknown }) {
  const envelope = toEnvelope(result)
  const changes = Array.isArray(envelope.changeSet) ? envelope.changeSet : []

  if (changes.length === 0) {
    return <JsonResultView result={result} />
  }

  return (
    <div className="result-view">
      <div className="result-summary">
        {isRecord(envelope.summary) ? JSON.stringify(envelope.summary) : `${changes.length} changes`}
      </div>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Action</th>
            <th>Asset</th>
            <th>Before</th>
            <th>After</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change, index) => (
            <tr key={`${change.assetPath || 'change'}-${index}`}>
              <td>{formatCell(change.status)}</td>
              <td>{formatCell(change.action)}</td>
              <td>{formatCell(change.assetPath)}</td>
              <td>{formatCell(change.before)}</td>
              <td>{formatCell(change.after)}</td>
              <td>{formatCell(change.message)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ResultRenderer({ result, resultType }: ResultRendererProps) {
  const view = viewForResult(result, resultType)

  if (view === 'assetTable') {
    return <AssetTableView result={result} />
  }

  if (view === 'issueTable') {
    return <IssueTableView result={result} />
  }

  if (view === 'changeSet') {
    return <ChangeSetView result={result} />
  }

  return <JsonResultView result={result} />
}
