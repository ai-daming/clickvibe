/**
 * clickvibe agent event-stream parser.
 *
 * Turns the structured JSON event streams of codex (`exec --json`) and
 * claude (`--print --verbose --output-format stream-json`) into human
 * status lines the panel renders like a TUI: the current action, the agent's
 * message, tool calls, and stage transitions.
 */
export type { AgentKind } from '../infra/contracts.ts'

import type { AgentKind } from '../infra/contracts.ts'

import { type LiveLogKind, type TokenUsage, tokenUsage } from '../infra/live-output.ts'

export interface StatusLine {
  kind: Exclude<LiveLogKind, 'system'>
  text: string
  usage?: TokenUsage
}

/** Classify a tool name into a friendly "current action" label. */
function toolLabel(name: string, args: string): string {
  switch (name) {
    case 'bash':
    case 'shell':
    case 'execute_command':
      return `🔧 执行命令: ${args}`
    case 'read':
    case 'read_file':
    case 'fs.read':
    case 'View':
      return `📖 读取文件: ${args}`
    case 'write':
    case 'write_file':
    case 'fs.write':
    case 'Edit':
      return `✍️ 修改文件: ${args}`
    case 'apply_patch':
    case 'MultiEdit':
      return `🩹 应用补丁: ${args}`
    case 'git':
    case 'git_diff':
      return `🌿 git: ${args}`
    case 'gh':
      return `🐙 gh: ${args}`
    case 'web_search':
    case 'WebSearch':
      return `🔍 搜索: ${args}`
    case 'web_fetch':
    case 'WebFetch':
      return `🌐 抓取网页: ${args}`
    case 'subagent':
    case 'task':
      return `🤖 子代理: ${args}`
    case 'ask_user_question':
    case 'AskUserQuestion':
      return `❓ 提问: ${args}`
    default:
      return `🛠️ ${name}: ${args}`
  }
}

/** Parse one codex JSON event into optional status lines. */
export function parseCodexEvent(line: string): StatusLine[] {
  const out: StatusLine[] = []
  let event: {
    type?: string
    item?: {
      type?: string
      text?: string
      name?: string
      arguments?: unknown
      command?: string
      aggregated_output?: string
    }
    thread_id?: string
    usage?: unknown
    info?: unknown
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
      if (tokenUsage(event.usage)) out.push({ kind: 'usage', text: '', usage: tokenUsage(event.usage) })
      break
    case 'token_count': {
      const usage = tokenUsage(event.usage ?? event.info ?? event)
      if (usage) out.push({ kind: 'usage', text: '', usage })
      break
    }
    case 'item.completed': {
      const item = event.item ?? {}
      switch (item.type) {
        case 'agent_message':
          out.push({ kind: 'message', text: `💬 ${item.text ?? ''}` })
          break
        case 'function_call': {
          let args = ''
          if (typeof item.arguments === 'string') args = item.arguments
          else if (item.arguments && typeof item.arguments === 'object') {
            try {
              args = JSON.stringify(item.arguments)
            } catch {
              /* ignore */
            }
          }
          out.push({ kind: 'tool', text: toolLabel(item.name ?? 'tool', args) })
          break
        }
        case 'command_execution':
          if (item.command) out.push({ kind: 'command', text: `$ ${item.command}` })
          if (item.aggregated_output) {
            for (const output of item.aggregated_output.replace(/\s+$/, '').split(/\r?\n/)) {
              if (output !== '') out.push({ kind: 'command_output', text: output })
            }
          }
          break
        case 'reasoning':
          if (item.text) out.push({ kind: 'reasoning', text: `◌ ${item.text}` })
          break
        case 'token_count': {
          const usage = tokenUsage(item)
          if (usage) out.push({ kind: 'usage', text: '', usage })
          break
        }
        case 'error':
          out.push({ kind: 'text', text: `⚠️ ${item.text ?? 'error'}` })
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
    message?: {
      content?: { type?: string; text?: string; thinking?: string; name?: string; input?: unknown }[]
      usage?: unknown
    }
    session_id?: string
    usage?: unknown
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
          out.push({ kind: 'message', text: `💬 ${block.text}` })
        } else if (block.type === 'thinking' && (block.thinking || block.text)) {
          out.push({ kind: 'thinking', text: `◌ ${block.thinking ?? block.text ?? ''}` })
        } else if (block.type === 'tool_use' && block.name) {
          const args = block.input ? JSON.stringify(block.input) : ''
          out.push({ kind: 'tool', text: toolLabel(block.name, args) })
        }
      }
      if (tokenUsage(event.message?.usage))
        out.push({ kind: 'usage', text: '', usage: tokenUsage(event.message?.usage) })
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
      if (tokenUsage(event.usage)) out.push({ kind: 'usage', text: '', usage: tokenUsage(event.usage) })
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
