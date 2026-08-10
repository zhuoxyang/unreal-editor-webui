import type { ReactNode } from 'react'
import type { ToolCatalogLoadStatus, ToolCatalogSource } from '../hooks/useToolCatalog'

type ToolShellHeaderProps = {
  catalogSource: ToolCatalogSource
  catalogStatus: ToolCatalogLoadStatus
  catalogSchemaVersion: 1
  healthPanel: ReactNode
}

export function ToolShellHeader({
  catalogSource,
  catalogStatus,
  catalogSchemaVersion,
  healthPanel,
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
        {healthPanel}
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
