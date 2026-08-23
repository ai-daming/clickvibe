import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PANEL_CSS } from '../src/client/styles.ts'

function clientSource(relativePath: string): string {
  return readFileSync(new URL(`../src/client/${relativePath}`, import.meta.url), 'utf8')
}

test('icon-only button audit checklist gives every control an accessible name', () => {
  const projectPanel = clientSource('views/project-panel.tsx')
  const deliveryTimeline = clientSource('views/delivery-timeline.tsx')

  const checklist = [
    [projectPanel, 'aria-label="强制同步远端并刷新详情"', '详情刷新 ⟳'],
    [projectPanel, 'aria-label="刷新 GitHub 与 git 状态"', '列表刷新 ⟳'],
    [projectPanel, 'aria-label="关闭 ClickVibe 面板"', '面板关闭 ✕'],
    [deliveryTimeline, 'aria-label="关闭详情"', '流水详情关闭 ×'],
  ] as const

  for (const [source, accessibleName, control] of checklist) {
    assert.match(source, new RegExp(accessibleName), `${control} 缺少可访问名称`)
  }
})

test('focus-visible styles cover panel content and injected controls outside the panel', () => {
  assert.match(
    PANEL_CSS,
    /:where\(\.cv-panel, \.cv-terminal-overlay, \.cv-audit-drawer\) :is\(button, select, input, textarea, a, summary\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--dsw-alias-state-business-primary\);[^}]*outline-offset:\s*1px;/,
  )
  assert.match(PANEL_CSS, /:where\(\.cv-toggle, \.cv-issue-organizer\):focus-visible\s*\{[^}]*outline:/)
})
