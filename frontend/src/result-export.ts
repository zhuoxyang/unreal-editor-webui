export function resultToJson(result: unknown) {
  return JSON.stringify(result, null, 2)
}

function escapeCsvCell(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

export function rowsToCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    return ''
  }

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  return [
    columns.map(escapeCsvCell).join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column])).join(',')),
  ].join('\n')
}

export function resultToMarkdownSummary(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return `# Result\n\n\`\`\`json\n${resultToJson(result)}\n\`\`\``
  }

  const record = result as Record<string, unknown>
  const summary = record.summary && typeof record.summary === 'object' ? (record.summary as Record<string, unknown>) : {}
  const lines = ['# Tool Result', '']

  for (const [key, value] of Object.entries(summary)) {
    lines.push(`- **${key}**: ${String(value)}`)
  }

  if (Array.isArray(record.issues)) {
    lines.push('', '## Issues')
    for (const issue of record.issues as Array<Record<string, unknown>>) {
      lines.push(`- ${String(issue.severity || 'info')}: ${String(issue.message || issue.assetPath || 'Issue')}`)
    }
  }

  if (Array.isArray(record.changeSet)) {
    lines.push('', '## Changes')
    for (const change of record.changeSet as Array<Record<string, unknown>>) {
      lines.push(`- ${String(change.status || 'pending')}: ${String(change.before)} -> ${String(change.after)}`)
    }
  }

  return lines.join('\n')
}

export function downloadText(filename: string, contents: string, mimeType: string) {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  window.setTimeout(() => {
    link.remove()
    URL.revokeObjectURL(url)
  }, 0)
}
