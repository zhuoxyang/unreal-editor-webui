type ToolShellHeaderProps = {
  bridgeReady: boolean
}

export function ToolShellHeader({ bridgeReady }: ToolShellHeaderProps) {
  return (
    <section className="tool-shell-header">
      <div>
        <p className="eyebrow">Unreal Editor WebUI</p>
        <h1>Tool Rack Workspace</h1>
        <p className="lede">
          Search, favorite, open, inspect, and run Unreal editor tools from a persistent workspace shell.
        </p>
      </div>
      <span className={bridgeReady ? 'status ready' : 'status'}>
        {bridgeReady ? 'Bridge ready' : 'Bridge unavailable'}
      </span>
    </section>
  )
}

