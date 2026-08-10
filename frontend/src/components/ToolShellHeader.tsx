import type { ToolCatalogLoadStatus, ToolCatalogSource } from '../hooks/useToolCatalog'

type ToolShellHeaderProps = {
  bridgeReady: boolean
  catalogSource: ToolCatalogSource
  catalogStatus: ToolCatalogLoadStatus
  catalogSchemaVersion: 1
}

export function ToolShellHeader({
  bridgeReady,
  catalogSource,
  catalogStatus,
  catalogSchemaVersion,
}: ToolShellHeaderProps) {
  return (
    <section className="tool-shell-header">
      <div>
        <p className="eyebrow">Unreal Editor WebUI</p>
        <h1>Tool Rack Workspace</h1>
        <p className="lede">
          Search, favorite, open, inspect, and run Unreal editor tools from a persistent workspace shell.
        </p>
      </div>
      <div className="header-statuses">
        <span className={bridgeReady ? 'status ready' : 'status'}>
          {bridgeReady ? 'Bridge ready' : 'Bridge unavailable'}
        </span>
        <span
          className={`catalog-source ${catalogStatus}`}
          data-tool-catalog-source={catalogSource}
          data-tool-catalog-schema-version={catalogSchemaVersion}
        >
          {catalogSource === 'project' ? 'Project catalog' : 'Starter catalog'} · schema v{catalogSchemaVersion}
          {catalogStatus === 'loading' ? ' · loading' : ''}
        </span>
      </div>
    </section>
  )
}
