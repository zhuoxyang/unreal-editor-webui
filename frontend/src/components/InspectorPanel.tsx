import type { ReactNode } from 'react'

type InspectorPanelProps = {
  title?: string
  favoriteLabel?: string
  onToggleFavorite?: () => void
  children: ReactNode
}

export function InspectorPanel({ title = 'Inspector', favoriteLabel, onToggleFavorite, children }: InspectorPanelProps) {
  return (
    <aside className="panel inspector-panel">
      <div className="panel-title-row">
        <h2>{title}</h2>
        {favoriteLabel && onToggleFavorite ? (
          <button type="button" onClick={onToggleFavorite}>
            {favoriteLabel}
          </button>
        ) : null}
      </div>
      {children}
    </aside>
  )
}
