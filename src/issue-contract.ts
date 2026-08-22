/**
 * ClickVibe issue 契约校验(docs/issue-contract.md)。
 *
 * 必填三项:
 * - 目标(做什么)
 * - 验收标准(至少一条 `- [ ]` checklist)
 * - 依赖(无 | Blocked by #NN)
 *
 * 用途:选取前把不满足契约的 issue 标记为『不满足契约』并提示补齐(修订 #8),
 * 不硬选——缺契约的 issue 不进入自动选取;机器可读结果(ok/missing)
 * 供自动选取(#9 按依赖图 + ready 判定)按契约排除。
 */

export interface IssueContractCheck {
  ok: boolean
  missing: string[]
}

/** 取 issue 正文中 `## 名称` 节的内容(到下一个 `## ` 节为止),节不存在返回 null。 */
function sectionOf(body: string, name: string): string | null {
  const match = body.match(new RegExp(`^##\\s*${name}\\s*$`, 'm'))
  if (!match || match.index === undefined) return null
  const rest = body.slice(match.index + match[0].length)
  const next = rest.match(/^##\s/m)
  return (next ? rest.slice(0, next.index ?? 0) : rest).trim()
}

const CHECKLIST_RE = /-\s*\[[ xX]\]/

export function checkIssueContract(body: string): IssueContractCheck {
  const missing: string[] = []
  const goal = sectionOf(body, '目标')
  const acceptance = sectionOf(body, '验收标准')
  const deps = sectionOf(body, '依赖')
  if (!goal) missing.push('目标')
  if (!acceptance || !CHECKLIST_RE.test(acceptance)) missing.push('验收标准')
  if (!deps || !(/^无\s*$/m.test(deps) || /Blocked by\s*#\d+/i.test(deps))) missing.push('依赖')
  return { ok: missing.length === 0, missing }
}
