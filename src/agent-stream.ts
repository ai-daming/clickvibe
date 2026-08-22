/**
 * clickvibe agent event-stream parser.
 *
 * Turns the structured JSON event streams of codex (`exec --json`) and
 * claude (`--print --verbose --output-format stream-json`) into human
 * status lines the panel renders like a TUI: the current action, the agent's
 * message, tool calls, and stage transitions.
 */
export type AgentKind = 'codex' | 'claude'

export interface StatusLine {
  kind: 'stage' | 'tool' | 'message' | 'text'
  text: string
}

/** Trim a string to a bounded single line for display. */
function oneLine(value: string, max = 140): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

/** Classify a tool name into a friendly "current action" label. */
function toolLabel(name: string, args: string): string {
  const short = oneLine(args, 80)
  switch (name) {
    case 'bash':
    case 'shell':
    case 'execute_command':
      return `🔧 执行命令: ${short}`
    case 'read':
    case 'read_file':
    case 'fs.read':
    case 'View':
      return `📖 读取文件: ${short}`
    case 'write':
    case 'write_file':
    case 'fs.write':
    case 'Edit':
      return `✍️ 修改文件: ${short}`
    case 'apply_patch':
    case 'MultiEdit':
      return `🩹 应用补丁: ${short}`
    case 'git':
    case 'git_diff':
      return `🌿 git: ${short}`
    case 'gh':
      return `🐙 gh: ${short}`
    case 'web_search':
    case 'WebSearch':
      return `🔍 搜索: ${short}`
    case 'web_fetch':
    case 'WebFetch':
      return `🌐 抓取网页: ${short}`
    case 'subagent':
    case 'task':
      return `🤖 子代理: ${short}`
    case 'ask_user_question':
    case 'AskUserQuestion':
      return `❓ 提问: ${short}`
    default:
      return `🛠️ ${name}: ${short}`
  }
}

/** Parse one codex JSON event into optional status lines. */
export function parseCodexEvent(line: string): StatusLine[] {
  const out: StatusLine[] = []
  let event: {
    type?: string
    item?: { type?: string; text?: string; name?: string; arguments?: unknown }
    thread_id?: string
  }
  try {
    event = JSON.parse(line)
  } catch {
    return out
  }
  switch (event.type) {
    case 'thread.started':
      out.push({ kind: 'stage', text: '🚀 会话开始' })
      break
    case 'turn.started':
      out.push({ kind: 'stage', text: '💭 开始一轮思考…' })
      break
    case 'turn.completed':
      out.push({ kind: 'stage', text: '✅ 本轮完成' })
      break
    case 'item.completed': {
      const item = event.item ?? {}
      switch (item.type) {
        case 'agent_message':
          // 结论类消息必须保留完整内容(截断会丢失 review 条目),
          // 所以消息截断上限远大于工具行
          out.push({ kind: 'message', text: `💬 ${oneLine(item.text ?? '', 4000)}` })
          break
        case 'function_call': {
          let args = ''
          if (typeof item.arguments === 'string') args = item.arguments
          else if (item.arguments && typeof item.arguments === 'object') {
            try { args = JSON.stringify(item.arguments) } catch { /* ignore */ }
          }
          out.push({ kind: 'tool', text: toolLabel(item.name ?? 'tool', args) })
          break
        }
        case 'error':
          out.push({ kind: 'text', text: `⚠️ ${oneLine(item.text ?? 'error')}` })
          break
        default:
          break
      }
      break
    }
    default:
      break
  }
  return out
}

/** Parse one claude stream-json event into optional status lines. */
export function parseClaudeEvent(line: string): StatusLine[] {
  const out: StatusLine[] = []
  let event: {
    type?: string
    message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] }
    session_id?: string
  }
  try {
    event = JSON.parse(line)
  } catch {
    return out
  }
  switch (event.type) {
    case 'assistant': {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          out.push({ kind: 'message', text: `💬 ${oneLine(block.text, 4000)}` })
        } else if (block.type === 'tool_use' && block.name) {
          const args = block.input ? oneLine(JSON.stringify(block.input), 80) : ''
          out.push({ kind: 'tool', text: toolLabel(block.name, args) })
        }
      }
      break
    }
    case 'system': {
      // system 事件可能含 tool_use 摘要
      const sub = event.message?.content?.[0]
      if (sub?.type === 'tool_use' && sub.name) {
        out.push({ kind: 'tool', text: toolLabel(sub.name, '') })
      }
      break
    }
    case 'result':
      out.push({ kind: 'stage', text: '✅ 会话结束' })
      break
    default:
      break
  }
  return out
}

/** Parse a chunk of agent stdout into status lines + the session id (if seen). */
export function parseAgentChunk(agent: AgentKind, chunk: string): { lines: StatusLine[]; sessionId: string | null } {
  const rawLines = chunk.split('\n').filter((l) => l.trim() !== '')
  const lines: StatusLine[] = []
  let sessionId: string | null = null
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string
        thread_id?: string
        session_id?: string
        item?: { type?: string; text?: string; name?: string; arguments?: unknown }
        message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] }
      }
      // codex: thread_id; claude: session_id
      const sid = parsed.thread_id ?? parsed.session_id
      if (sid) sessionId = sid
    } catch {
      // 非 JSON 行,跳过
    }
    if (agent === 'codex') lines.push(...parseCodexEvent(line))
    else lines.push(...parseClaudeEvent(line))
  }
  return { lines, sessionId }
}
