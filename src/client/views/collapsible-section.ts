import React from 'react'

interface SectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): SectionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readSectionExpanded(storage: SectionStorage | null, key: string, defaultExpanded: boolean): boolean {
  try {
    const value = storage?.getItem(key)
    return value === 'true' ? true : value === 'false' ? false : defaultExpanded
  } catch {
    return defaultExpanded
  }
}

export function writeSectionExpanded(storage: SectionStorage | null, key: string, expanded: boolean): void {
  try {
    storage?.setItem(key, String(expanded))
  } catch {
    // Storage can be unavailable in privacy mode or when its quota is full.
  }
}

export function sectionStorageKey(issueUrl: string | undefined, section: string): string {
  return `clickvibe:detail-section:${issueUrl ?? 'unknown'}:${section}`
}

export function CollapsibleSection({
  storageKey,
  title,
  defaultExpanded,
  children,
}: {
  storageKey: string
  title: string
  defaultExpanded: boolean
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = React.useState(() =>
    readSectionExpanded(browserStorage(), storageKey, defaultExpanded),
  )
  const contentId = React.useId()
  const toggle = () => {
    setExpanded((current) => {
      const next = !current
      writeSectionExpanded(browserStorage(), storageKey, next)
      return next
    })
  }
  const toggleButton = React.createElement(
    'button',
    {
      type: 'button',
      className: 'cv-section-toggle',
      'aria-expanded': expanded,
      'aria-controls': contentId,
      onClick: toggle,
    },
    React.createElement('span', null, title),
    React.createElement('span', { 'aria-hidden': true }, expanded ? '▾' : '▸'),
  )
  return React.createElement(
    'section',
    { className: 'cv-section' },
    React.createElement('div', { className: 'cv-section-head' }, toggleButton),
    expanded ? React.createElement('div', { id: contentId, className: 'cv-section-content' }, children) : null,
  )
}
