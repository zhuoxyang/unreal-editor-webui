type MessageLogPanelProps = {
  emptyMessage: string
  lines: string[]
  title: string
}

export function MessageLogPanel({ emptyMessage, lines, title }: MessageLogPanelProps) {
  return (
    <div className="panel log-panel">
      <h2>{title}</h2>
      {lines.length > 0 ? <pre>{lines.join('\n')}</pre> : <p className="muted">{emptyMessage}</p>}
    </div>
  )
}

