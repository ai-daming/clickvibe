import React from 'react'
import { buildLogBlocks, collapseLogBlock, toggleExpandedLogBlock } from './log-blocks.ts'
import type { LiveLogEvent } from './runtime.ts'

export function LogBlocks({ events, taskId }: { events: readonly LiveLogEvent[]; taskId: string | null }) {
  const [expandedBlocks, setExpandedBlocks] = React.useState<Set<string>>(() => new Set())
  const blocks = buildLogBlocks(events)

  const toggleBlock = (id: string) => {
    const expansionId = `${taskId ?? 'history'}:${id}`
    setExpandedBlocks((current) => toggleExpandedLogBlock(current, expansionId))
  }

  return blocks.map((block) => {
    const collapsed = collapseLogBlock(block.text)
    const expansionId = `${taskId ?? 'history'}:${block.id}`
    const expanded = collapsed.collapsible && expandedBlocks.has(expansionId)
    return React.createElement(
      'div',
      {
        key: block.id,
        className: `cv-terminal-block cv-terminal-line-${block.source === 'system' ? 'system' : block.kind}`,
      },
      React.createElement(
        'div',
        { className: 'cv-terminal-block-text' },
        expanded ? collapsed.fullText : collapsed.text,
      ),
      collapsed.collapsible
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'cv-terminal-block-toggle',
              'aria-expanded': expanded,
              onClick: () => toggleBlock(block.id),
            },
            `${expanded ? '收起' : '展开'} ${collapsed.lineCount} 行`,
          )
        : null,
    )
  })
}
