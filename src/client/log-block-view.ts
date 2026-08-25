import React from 'react'
import { buildLogBlocks, collapseLogBlock, numberLogLines, toggleExpandedLogBlock } from './log-blocks.ts'
import type { LiveLogEvent } from './runtime.ts'

export function LogBlocks({ events, taskId }: { events: readonly LiveLogEvent[]; taskId: string | null }) {
  const [expandedBlocks, setExpandedBlocks] = React.useState<Set<string>>(() => new Set())
  const blocks = buildLogBlocks(events)
  let nextLineNumber = 1

  const toggleBlock = (id: string) => {
    const expansionId = `${taskId ?? 'history'}:${id}`
    setExpandedBlocks((current) => toggleExpandedLogBlock(current, expansionId))
  }

  return blocks.map((block) => {
    const collapsed = collapseLogBlock(block.text)
    const startLineNumber = nextLineNumber
    nextLineNumber += Math.max(1, collapsed.lineCount)
    const expansionId = `${taskId ?? 'history'}:${block.id}`
    const expanded = collapsed.collapsible && expandedBlocks.has(expansionId)
    const visibleLines = numberLogLines(expanded ? collapsed.fullText : collapsed.text, startLineNumber)
    return React.createElement(
      'div',
      {
        key: block.id,
        className: `cv-terminal-block cv-terminal-line-${block.source === 'system' ? 'system' : block.kind}`,
      },
      React.createElement(
        'div',
        { className: 'cv-terminal-block-text' },
        visibleLines.map((line) =>
          React.createElement(
            'div',
            { className: 'cv-terminal-row', key: line.number },
            React.createElement(
              'span',
              { className: 'cv-terminal-line-number', 'aria-hidden': true, title: `第 ${line.number} 行` },
              line.number,
            ),
            React.createElement('span', { className: 'cv-terminal-line-content' }, line.text),
          ),
        ),
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
