/**
 * 动作命令化(issue #13):把 ClickVibe 的每个操作变成一条可在对话中触发的
 * 纯文本命令。本模块只做两件纯函数的事:
 * 1. parseCommand —— 严格语法解析(动词别名 + 目标 + 选项),不碰任何 I/O;
 * 2. formatXxx   —— 把后端动作结果渲染成对话里可直接展示的可读文本。
 *
 * 命令的执行不在这里:路由层(src/index.ts 的 /clickvibe/api/command)把解析
 * 结果转发给与 UI 按钮完全相同的后端动作,保证「一套动作,两个入口」。
 *
 * 语法(详见 docs/command-reference.md):
 *   help | projects
 *   issues [repoKey]
 *   status <#N | N | issue-url> [repoKey]
 *   develop <target> [repoKey] [codex|claude|dryrun] [context=<rest>]
 *   review <target> [repoKey] [codex|claude]
 *   rework|resume <target> [repoKey] [context=<rest>]
 *   auto <target> [dev=codex|claude] [review=codex|claude] [rounds=N] [budget=H] [merge=on|off]
 *   merge|sync|restore-base|stop <target> [repoKey]
 * 动词支持中文别名(下单开发/开始开发/审查/返工/恢复/合并/同步/停止/状态/
 * 列表/项目/帮助/安全演练),允许「把/请/帮我/用/一下」等语气词;自然语言
 * 由对话 agent 翻译成这里的严格语法,服务端不做模糊猜测。
 */

/** 可命令化的操作。dryrun 是 develop 的 agent 选项,不是独立动作。 */
export type CommandAction =
  | 'help'
  | 'projects'
  | 'issues'
  | 'status'
  | 'develop'
  | 'review'
  | 'rework'
  | 'resume'
  | 'auto'
  | 'merge'
  | 'sync'
  | 'restore-base'
  | 'stop'

/** One parsed command; target number/repoKey stay raw strings until the route resolves them. */
export interface ParsedCommand {
  action: CommandAction
  /** Full GitHub issue/PR URL when the target was written as a URL, else null. */
  url: string | null
  /** Issue number (digits only) or null for repo-level commands. */
  number: string | null
  /** Explicit `owner/repo`, or the repo of a URL target. Null when absent. */
  repoKey: string | null
  agent: 'codex' | 'claude' | 'dryrun' | null
  /** Free-form extra instructions (`context=`…), trimmed. */
  context: string
  /** Manual-override reason for merge (`override=…`, issue #49); empty = no override. */
  overrideReason: string
  autoRun: {
    autoMerge: boolean
    devAgent: 'codex' | 'claude'
    reviewAgent: 'codex' | 'claude'
    maxRounds: number
    budgetHours: number
  } | null
  autoRunAgentOverrides: { dev: boolean; review: boolean } | null
}

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string }

/** 动词 → 动作。多词别名先匹配(在 tokenize 前做整串替换)。 */
const VERB_ALIASES: Array<[RegExp, CommandAction | 'dryrun']> = [
  [/\bhelp\b|^帮助$|^命令$/, 'help'],
  [/\bprojects?\b|^项目列表$|^项目$/, 'projects'],
  [/\bissues?\b|^工单列表$|^列表$|^issue列表$/, 'issues'],
  [/\bstatus\b|\bstate\b|^看状态$|^状态$|^进度$/, 'status'],
  [/安全演练|^演练$|\bdry[- ]?run\b/, 'dryrun'],
  [/下单开发|开始开发|^下单$|\bdevelop\b|\bdev\b|^开发$/, 'develop'],
  [/自动跑到底|^自动推进$|\bauto\b/, 'auto'],
  [/按意见返工|^返工$|\brework\b/, 'rework'],
  [/恢复开发|^恢复$|\bresume\b/, 'resume'],
  [/^合并$|\bmerge\b/, 'merge'],
  [/恢复基线|\brestore-base\b/, 'restore-base'],
  [/同步基线|^同步$|\bsync\b/, 'sync'],
  [/^停止$|^停下$|\bstop\b/, 'stop'],
  [/^审查$|^review一下$|\breview\b/, 'review'],
]

/** 语气词:解析前整体剔除,让『把 #8 下单开发』『请帮我看看状态』直接可用。 */
const FILLER = /^(把|请|帮我|帮忙|用|一下|给|跑|执行)$/

const ACTIONS_REQUIRING_TARGET: readonly CommandAction[] = [
  'status',
  'develop',
  'review',
  'rework',
  'resume',
  'auto',
  'merge',
  'sync',
  'restore-base',
  'stop',
]

/** Parse one command line. Pure; never throws. */
export function parseCommand(input: string): ParseResult {
  const raw = input.trim().replace(/^\/clickvibe\s+/, '')
  if (raw === '') return { ok: false, error: '命令为空。发送 help 查看全部可命令化操作。' }

  // context=/override=<rest of line>:作为整体剥离,避免其中的空格破坏分词
  let context = ''
  let overrideReason = ''
  let remainder = raw
  for (const key of ['context', 'override'] as const) {
    const at = remainder.search(new RegExp(`(?:^|\\s)${key}=`))
    if (at < 0) continue
    const value = remainder
      .slice(at)
      .replace(new RegExp(`^\\s*${key}=`), '')
      .trim()
      .replace(/^["“](.*)["”]$/, '$1')
      .trim()
    if (value === '') return { ok: false, error: `${key}= 后面是空的;如不需要请删掉它。` }
    if (key === 'context') context = value
    else overrideReason = value
    remainder = remainder.slice(0, at).trim()
  }

  // 中文习惯不在 # 前后留空格(「把#8下单开发」),先规范化出独立 token
  const tokens = remainder
    .replace(/#(\d+)/g, ' #$1 ')
    .split(/\s+/)
    .filter((token) => token !== '' && !FILLER.test(token))

  const command: ParsedCommand = {
    action: 'help',
    url: null,
    number: null,
    repoKey: null,
    agent: null,
    context,
    overrideReason,
    autoRun: null,
    autoRunAgentOverrides: null,
  }
  const autoOptions: NonNullable<ParsedCommand['autoRun']> = {
    autoMerge: false,
    devAgent: 'codex',
    reviewAgent: 'codex',
    maxRounds: 20,
    budgetHours: 24,
  }
  const autoAgentOverrides = { dev: false, review: false }
  let sawAutoOption = false
  let sawVerb = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    // URL 目标:github.com/<owner>/<repo>/(issues|pull)/<n>
    const urlMatch = token.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/)
    if (urlMatch) {
      command.url = token
      command.number = urlMatch[3]
      command.repoKey = `${urlMatch[1]}/${urlMatch[2]}`
      continue
    }
    if (/^#\d+$/.test(token) || /^\d+$/.test(token)) {
      command.number = token.replace(/^#/, '')
      continue
    }
    if (/^[\w.-]+\/[\w.-]+$/.test(token)) {
      command.repoKey = token
      continue
    }
    if (token === 'codex' || token === 'claude' || token === 'dryrun') {
      command.agent = token
      continue
    }
    if (/^agent=\S+$/.test(token)) {
      const value = token.slice('agent='.length)
      if (value !== 'codex' && value !== 'claude' && value !== 'dryrun') {
        return { ok: false, error: `未知 agent "${value}",只支持 codex / claude / dryrun。` }
      }
      command.agent = value
      continue
    }
    if (/^(dev|review)=(codex|claude)$/.test(token)) {
      sawAutoOption = true
      const [key, value] = token.split('=') as ['dev' | 'review', 'codex' | 'claude']
      if (key === 'dev') {
        autoOptions.devAgent = value
        autoAgentOverrides.dev = true
      } else {
        autoOptions.reviewAgent = value
        autoAgentOverrides.review = true
      }
      continue
    }
    if (/^(rounds|budget)=\S+$/.test(token)) {
      sawAutoOption = true
      const [key, rawValue] = token.split('=', 2)
      const value = Number(rawValue)
      if (!Number.isFinite(value) || value <= 0 || (key === 'rounds' && !Number.isInteger(value))) {
        return { ok: false, error: `${key} 必须是${key === 'rounds' ? '正整数' : '正数'}` }
      }
      if (key === 'rounds') autoOptions.maxRounds = value
      else autoOptions.budgetHours = value
      continue
    }
    if (/^merge=\S+$/.test(token)) {
      sawAutoOption = true
      const value = token.slice('merge='.length)
      if (value !== 'on' && value !== 'off') return { ok: false, error: 'merge 只支持 on / off' }
      autoOptions.autoMerge = value === 'on'
      continue
    }
    if (!sawVerb) {
      const alias = VERB_ALIASES.find(([pattern]) => pattern.test(token))
      if (alias) {
        if (alias[1] === 'dryrun') {
          command.action = 'develop'
          command.agent = 'dryrun'
        } else {
          command.action = alias[1]
        }
        sawVerb = true
        continue
      }
    }
    return { ok: false, error: `无法识别 "${token}"。命令语法见 help,或查阅 docs/command-reference.md。` }
  }

  if (!sawVerb) return { ok: false, error: `缺少动作动词(如 develop / review / merge / status)。发送 help 查看用法。` }
  if (ACTIONS_REQUIRING_TARGET.includes(command.action) && command.number === null) {
    return {
      ok: false,
      error: `${command.action} 需要一个 issue 目标(如 ${command.action} #8 或 ${command.action} 8 owner/repo)。`,
    }
  }
  if (overrideReason !== '' && command.action !== 'merge') {
    return { ok: false, error: 'override= 只用于 merge 命令的门禁人工放行。' }
  }
  if (sawAutoOption && command.action !== 'auto') {
    return { ok: false, error: 'dev=/review=/rounds=/budget=/merge= 只用于 auto 命令。' }
  }
  if (command.action === 'auto') {
    command.autoRun = autoOptions
    command.autoRunAgentOverrides = autoAgentOverrides
  }
  return { ok: true, command }
}

export function applyPreviousAutoRunAgents(
  config: NonNullable<ParsedCommand['autoRun']>,
  overrides: NonNullable<ParsedCommand['autoRunAgentOverrides']>,
  previous: { devAgent?: 'codex' | 'claude' | null; reviewAgent?: 'codex' | 'claude' | null } | null,
): NonNullable<ParsedCommand['autoRun']> {
  const devAgent = overrides.dev ? config.devAgent : (previous?.devAgent ?? config.devAgent)
  return {
    ...config,
    devAgent,
    reviewAgent: overrides.review ? config.reviewAgent : (previous?.reviewAgent ?? previous?.devAgent ?? devAgent),
  }
}

export const COMMAND_HELP_TEXT = [
  'ClickVibe 命令(对话可直接触发,与面板按钮走同一套后端动作):',
  '  help                                查看本帮助',
  '  projects                            列出已配置的项目',
  '  issues [repoKey]                    列出项目 issue 与下一步动作',
  '  status <#N|URL> [repoKey]           查看某 issue 的权威状态',
  '  develop <目标> [repoKey] [agent]    下单开发(codex/claude;安全演练用 dryrun)',
  '  review <目标> [repoKey] [agent]     启动 review',
  '  rework <目标> [context=…]           按 review 意见返工',
  '  resume <目标> [context=…]           恢复中断的开发会话',
  '  auto <目标> [dev=… review=… rounds=20 budget=24 merge=off]  自动跑到底',
  '  sync <目标>                         同步 worktree 到远端基线',
  '  restore-base <目标>                 按最后已知 tip 恢复已删除的远端基线(需二次确认)',
  '  stop <目标>                         停止任务;未知态需确认旧 agent 已停止后重发',
  '  merge <目标>                        合并 PR 并清理(需二次确认)',
  '  merge <目标> override=<放行原因>    门禁拒绝后的人工放行(跳过项与原因写入审计)',
  '',
  '写操作是两阶段的:先返回预览与一次性授权(2 分钟有效),用户在对话里确认后,',
  '携带 authorizationId / authorizationDigest 原样重发同一命令才会执行。',
  '目标写法:#8、8 或完整 issue URL;配置了多个项目时需带 repoKey(如 ai-daming/clickvibe)。',
].join('\n')

/** 细节文档见 docs/command-reference.md;help 文本与此保持一致。 */
export function formatProjects(projects: { repoKey: string; path: string; available: boolean }[]): string {
  if (projects.length === 0)
    return '尚未配置任何项目。请在 ~/.clickvibe/config.yaml 的 repos 中添加 owner/repo → 本机路径。'
  return [
    '已配置的项目:',
    ...projects.map((project) => `- ${project.repoKey} → ${project.path}${project.available ? '' : '(路径不可用)'}`),
  ].join('\n')
}

/** Workflow facts the issue-list formatter needs (subset of the /repo/issues item). */
export interface CommandIssueItem {
  number: number
  title: string
  state: string
  url: string
  blockedBy?: { number: number; state: string }[]
  workflow?: {
    derived?: { status?: string; nextAction?: { label?: string } | null }
  } | null
}

export function formatIssueList(repoKey: string, issues: CommandIssueItem[]): string {
  if (issues.length === 0) return `项目 ${repoKey} 没有可见 issue。`
  const lines = [`项目 ${repoKey} · ${issues.length} 个 issue:`]
  for (const issue of issues) {
    const next = issue.workflow?.derived?.nextAction?.label
    const blocked = (issue.blockedBy ?? []).filter((dep) => dep.state !== 'CLOSED')
    const suffix = [
      next ? `下一步:${next}` : null,
      blocked.length > 0 ? `被 ${blocked.map((dep) => `#${dep.number}`).join('、')} 阻塞` : null,
    ]
      .filter(Boolean)
      .join(';')
    lines.push(`- #${issue.number} [${issue.state}] ${issue.title}${suffix ? ` —— ${suffix}` : ''}`)
  }
  return lines.join('\n')
}

/** Workflow facts the status formatter needs (subset of IssueWorkflow & { derived }). */
export interface CommandStatusWorkflow {
  url: string
  branch: string
  worktree: string
  prNumber: string | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  derived?: {
    head: string | null
    status: string
    aheadOfBase: number
    behindBase: number
    needsSync: boolean
    mergeConflict: boolean
    verdictCurrent: boolean
    nextAction: { kind: string; label: string; hint: string }
  } | null
  events?: { kind: string; at: string; note?: string }[]
}

const STATUS_LABELS: Record<string, string> = {
  idle: '未开发',
  developing: '开发中',
  'review-ready': '待 review',
  reviewing: 'review 中',
  passed: 'review 通过',
}

export function formatStatus(workflow: CommandStatusWorkflow | null, issueNumber: string): string {
  if (!workflow) {
    return `#${issueNumber} 在本机还没有 ClickVibe workflow(尚未下过开发单)。可先 issues 查看项目工单,或 develop ${issueNumber} 下单。`
  }
  const derived = workflow.derived
  const status = STATUS_LABELS[derived?.status ?? 'idle'] ?? derived?.status ?? '未知'
  const lines = [`#${issueNumber} · ${status}`, `- 分支:${workflow.branch}(HEAD ${derived?.head ?? '未知'})`]
  if (workflow.prNumber) lines.push(`- PR:#${workflow.prNumber}`)
  if (workflow.reviewResult) {
    const verdict = workflow.reviewResult.passed
      ? derived?.verdictCurrent
        ? `通过,结论有效(${workflow.reviewResult.issues.length} 条遗留为 0)`
        : '通过,但结论已过期(需重新 review)'
      : `未通过(${workflow.reviewResult.issues.length} 条意见)`
    lines.push(`- review:${verdict}`)
  }
  if (derived) {
    const aheadBehind = `领先基线 ${derived.aheadOfBase} / 落后 ${derived.behindBase}`
    lines.push(
      `- 基线对比:${derived.mergeConflict ? '存在未解决的合并冲突' : derived.needsSync ? `${aheadBehind},需要同步` : aheadBehind}`,
    )
  }
  lines.push(`- 下一步:${derived?.nextAction.label ?? '无'} —— ${derived?.nextAction.hint ?? ''}`)
  return lines.join('\n')
}

/** Preview payload shape returned by the shared authorize path. */
export interface CommandAuthorizationPreview {
  action?: string
  agent?: string | null
  url?: string
  title?: string
  updatedAt?: string
  commentCount?: number
  digest?: string
  prNumber?: string
  branch?: string
  head?: string
  baseRef?: string
  baseSha?: string
  mergeFlag?: string
  cleanup?: string[]
  baseline?: string
  baselineRef?: string | null
  override?: {
    skipped?: string[]
    reason?: string
    gates?: { key?: string; message?: string }[]
  }
  autoRun?: ParsedCommand['autoRun']
}

export function formatConfirmationPreview(
  action: CommandAction,
  agent: string | null,
  preview: CommandAuthorizationPreview,
  digest: string,
  expiresAt: number,
): string {
  const expireNote = `授权 ${digest.slice(0, 12)}(有效期至 ${new Date(expiresAt).toISOString()})`
  if (action === 'develop' && agent !== 'dryrun') {
    return [
      `即将以高权限启动 ${agent} 开发以下已冻结快照:`,
      '',
      `${preview.title ?? preview.url ?? ''}`,
      `更新时间:${preview.updatedAt || '未知'} · 评论 ${preview.commentCount ?? 0} 条`,
      '',
      '请用户在对话中明确确认(如「确认」)。确认后携带授权原样重发命令即可执行;快照在执行前还会再次校验,过期则需重新预览。',
      expireNote,
    ].join('\n')
  }
  if (action === 'auto') {
    const config = preview.autoRun
    return [
      '即将启动自动跑到底(每步完成后重新观察权威事实):',
      `- 目标:${preview.title ?? preview.url ?? ''}`,
      `- 开发 agent:${config?.devAgent ?? '?'} · Review agent:${config?.reviewAgent ?? '?'}`,
      `- 轮次上限:${config?.maxRounds ?? '?'} · 总预算:${config?.budgetHours ?? '?'} 小时`,
      `- 自动合并:${config?.autoMerge ? '开(仍执行全部门禁)' : '关(默认停在待合并)'}`,
      '',
      '请用户明确确认后携带一次性授权原样重发命令。',
      expireNote,
    ].join('\n')
  }
  if (action === 'merge') {
    const gates = preview.override?.gates ?? []
    return [
      '即将执行不可逆的合并与清理:',
      `- PR:#${preview.prNumber ?? '?'}(分支 ${preview.branch ?? '?'},HEAD ${preview.head ?? '?'})`,
      `- PR base:${preview.baseRef ?? '?'} @ ${preview.baseSha ?? '?'}`,
      `- 策略:${preview.mergeFlag ?? '--merge'}(merge commit,禁止 squash/rebase)`,
      `- 清理:${(preview.cleanup ?? []).join('、')}`,
      ...(gates.length > 0
        ? [
            '- 人工放行:将跳过以下 ClickVibe 门禁(写入审计,不绕过 GitHub 保护):',
            ...gates.map((gate) => `  · ${gate.message ?? gate.key ?? ''}`),
            `  放行原因:${preview.override?.reason ?? ''}`,
          ]
        : []),
      '',
      '合并是人的决策,必须由用户明确确认后携带授权重发命令。',
      expireNote,
    ].join('\n')
  }
  if (action === 'restore-base') {
    return [
      '即将恢复远端基线后继续创建 PR:',
      `- 基线:${preview.baseline ?? '?'}`,
      `- 最后已知 tip:${preview.baselineRef ?? '?'}`,
      '- 安全条件:仅当远端同名分支仍不存在时创建;若已恢复到不同提交则拒绝覆盖。',
      '',
      '请用户明确确认后携带授权原样重发命令。',
      expireNote,
    ].join('\n')
  }
  return [
    `即将以高权限执行 ${action}${agent && agent !== 'dryrun' ? `(agent:${agent})` : ''}。`,
    `目标:${preview.url ?? ''}`,
    '',
    '请用户确认后携带授权原样重发命令。',
    expireNote,
  ].join('\n')
}

/** Merge rejected by the ClickVibe gates (issue #49): list every failure and the override path. */
export function formatMergeGateRejection(
  url: string,
  failures: { key?: string; message?: string }[],
  labels: (key: string) => string,
): string {
  return [
    `合并被 ClickVibe 门禁拒绝(${url}):`,
    ...failures.map((failure) => `- [${labels(failure.key ?? '')}] ${failure.message ?? ''}`),
    '',
    '逐项确认后,可用人工放行跳过以上门禁(仅跳过 ClickVibe 自身门禁,不绕过 GitHub 分支保护;',
    `放行原因必填并写入审计):merge <目标> override=<放行原因>。重新 Review 通过则无需放行。`,
  ].join('\n')
}
