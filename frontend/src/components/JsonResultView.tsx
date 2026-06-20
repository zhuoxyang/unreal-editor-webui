type JsonResultViewProps = {
  result: unknown
}

export function JsonResultView({ result }: JsonResultViewProps) {
  return (
    <div className="result-view">
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </div>
  )
}
