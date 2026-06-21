import type { ReactNode } from 'react'

export type WorkspaceTab = {
  name: string
  icon?: string
}

type WorkspacePanelProps = {
  tabs: WorkspaceTab[]
  activeTabName: string | null
  title?: string
  subtitle?: string
  category?: string
  badges?: ReactNode
  result: ReactNode
  onSelectTab: (name: string) => void
  onCloseTab: (name: string) => void
}

export function WorkspacePanel({
  tabs,
  activeTabName,
  title,
  subtitle,
  category,
  badges,
  result,
  onSelectTab,
  onCloseTab,
}: WorkspacePanelProps) {
  return (
    <section className="panel workspace-panel">
      <div className="workspace-tabs">
        {tabs.length === 0 ? (
          <span className="muted">Select a tool to open a workspace tab.</span>
        ) : (
          tabs.map((tab) => (
            <button
              className={activeTabName === tab.name ? 'workspace-tab active' : 'workspace-tab'}
              key={tab.name}
              type="button"
              onClick={() => onSelectTab(tab.name)}
            >
              <span>{tab.icon || tab.name[0]?.toUpperCase() || '?'}</span>
              {tab.name}
              <span
                className="workspace-tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseTab(tab.name)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    onCloseTab(tab.name)
                  }
                }}
              >
                x
              </span>
            </button>
          ))
        )}
      </div>

      <div className="workspace-content">
        {title ? (
          <div className="workspace-tool-header">
            <div>
              <p className="eyebrow">{category}</p>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
            {badges ? <span className="badge-group">{badges}</span> : null}
          </div>
        ) : null}
        <div className="workspace-result">{result}</div>
      </div>
    </section>
  )
}
