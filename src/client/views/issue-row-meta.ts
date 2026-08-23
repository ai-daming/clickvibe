/** Structured, priority-aware metadata for a project issue row. */
import React from 'react'

interface RowDependency {
  number: number
  state: string
}

interface IssueRowMetaProps {
  branch: string | null
  milestone: string | null
  blockedBy: RowDependency[]
  behindBase: number
  contract?: { ok: boolean; missing: string[] }
  autoDevelopmentReady: boolean
  dependencyLedger?: { updated: boolean; error?: string }
}

interface MetaItemProps {
  label: string
  value: string
  className?: string
  secondary?: boolean
  title?: string
}

function MetaItem({ label, value, className = '', secondary = false, title = value }: MetaItemProps) {
  const classes = ['cv-row-meta-item', secondary ? 'cv-row-meta-secondary' : '', className].filter(Boolean).join(' ')
  return React.createElement(
    'span',
    { className: classes },
    React.createElement('span', { className: 'cv-row-meta-label' }, label),
    React.createElement('span', { className: 'cv-row-meta-value', title }, value),
  )
}

export function IssueRowMeta({
  branch,
  milestone,
  blockedBy,
  behindBase,
  contract,
  autoDevelopmentReady,
  dependencyLedger,
}: IssueRowMetaProps) {
  const branchValue = branch || '无'
  const milestoneValue = milestone || '无'
  const blockedByValue = blockedBy.length
    ? blockedBy
        .map((dependency) => `#${dependency.number}${dependency.state.toUpperCase() === 'OPEN' ? '⏳' : '✓'}`)
        .join(' ')
    : '无'
  const signals = [
    behindBase > 0
      ? React.createElement(MetaItem, {
          key: 'lag',
          label: '滞后',
          value: `落后 ${behindBase}`,
          className: 'cv-row-lag',
        })
      : null,
    contract && !contract.ok
      ? React.createElement(MetaItem, {
          key: 'contract',
          label: '契约',
          value: `不满足契约（缺：${contract.missing.join('、')}）`,
          className: 'cv-row-contract',
        })
      : null,
    autoDevelopmentReady
      ? React.createElement(MetaItem, {
          key: 'automation',
          label: '自动化',
          value: 'ready · 可自动下单',
          className: 'cv-row-ready',
        })
      : null,
    dependencyLedger?.updated
      ? React.createElement(MetaItem, {
          key: 'ledger-updated',
          label: '依赖账本',
          value: '已自动更新',
          className: 'cv-row-ready',
        })
      : null,
    dependencyLedger?.error
      ? React.createElement(MetaItem, {
          key: 'ledger-error',
          label: '依赖账本',
          value: '更新失败',
          className: 'cv-row-contract',
          title: dependencyLedger.error,
        })
      : null,
  ].filter((signal) => signal !== null)

  return React.createElement(
    'div',
    { className: 'cv-issue-row-meta' },
    React.createElement(
      'div',
      { className: 'cv-row-meta-layer cv-row-meta-primary' },
      React.createElement(MetaItem, { label: '分支', value: branchValue }),
      React.createElement(MetaItem, { label: 'blockedBy', value: blockedByValue }),
      React.createElement(MetaItem, { label: '里程碑', value: milestoneValue, secondary: true }),
    ),
    signals.length > 0
      ? React.createElement('div', { className: 'cv-row-meta-layer cv-row-meta-signals' }, signals)
      : null,
  )
}
