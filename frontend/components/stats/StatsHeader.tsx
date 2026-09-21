import type { ReactNode } from 'react'
import './stats-theme.css'

// The page's masthead: title and scope on one line, wayfinding on the next,
// one hairline closing the whole block. The filters belong up here beside
// the title because they say which slice of the page below is being shown —
// they are chrome, not content, and a titled Card gave them the same visual
// weight as the numbers they scope.

export type HeaderTab = { key: string; label: string }

export default function StatsHeader({ title, tabs, activeKey, onSelect, children }: {
  title: string
  tabs: HeaderTab[]
  activeKey: string
  onSelect: (key: string) => void
  /** Scope controls, right-aligned against the title. */
  children?: ReactNode
}) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="st-title">{title}</h1>
        {children}
      </div>

      {/* role=tablist is deliberately absent: these navigate the router and
          each one owns a URL, so they are links in behaviour even though
          they render as buttons. Announcing them as tabs would promise
          arrow-key semantics this does not implement. */}
      <nav className="st-tabs" aria-label="Stats sections">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            className="st-tab"
            data-active={activeKey === t.key}
            aria-current={activeKey === t.key ? 'page' : undefined}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  )
}
