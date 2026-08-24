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

import { LineBuffer } from '../infra/line-buffer.ts'
import { type LiveLogKind, type TokenUsage, tokenUsage } from '../infra/live-output.ts'

export interface StatusLine {
  kind: Exclude<LiveLogKind, 'system'>
  text: string
  usage?: TokenUsage
}

export function lossyAgentOutputNotice(read: {
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}): string | null {
  if (!read.lossy) return null
  const spillFiles = [
    read.stdoutSpillPath ? `stdout ${read.stdoutSpillPath}` : '',
    read.stderrSpillPath ? `stderr ${read.stderrSpillPath}` : '',
  ].filter(Boolean)
  return spillFiles.length > 0
    ? `[clickvibe] 宿主流式缓冲已丢失部分 Agent 输出；可从宿主 spill 文件恢复：${spillFiles.join('；')}`
    : '[clickvibe] 宿主流式缓冲已丢失部分 Agent 输出；宿主未提供 spill 文件，缺口无法从 ClickVibe 日志恢复'
}

/**
 * Split host spill text into lines using the same line-buffer semantics the
 * live delta stream flows through (
 and split chunks normalize the same
 * way), so recovered lines match delivered lines byte-for-byte.
 */
function splitSpillLines(text: string): string[] {
  const buffer = new LineBuffer()
  return [...buffer.appendChunk(text), ...buffer.flush()].filter((line) => line !== '')
}

/**
 * Lines the host spill file holds that the live delta stream never delivered.
 * The host keeps only a bounded in-memory tail and drops the head; the spill
 * file is byte-complete, so re-parsing these lines fills the gap. Idempotent:
 * a line already delivered is skipped, so re-reading the same spill never
 * duplicates panel lines.
 */
export function recoverSpillLines(spillText: string, deliveredLines: ReadonlySet<string>): string[] {
  return splitSpillLines(spillText).filter((line) => !deliveredLines.has(line))
}

/** Closing notice once missing agent lines were recovered from host spill files. */
export function spillRecoveryNotice(recoveredPaths: string[], lineCount: number): string | null {
  if (recoveredPaths.length === 0 || lineCount <= 0) return null
  return `[clickvibe] 已从宿主 spill 文件恢复 ${lineCount} 行缺失的 Agent 输出: ${recoveredPaths.join('；')}`
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
          if (item.aggregated_output) out.push({ kind: 'command_output', text: item.aggregated_output })
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
          out.push({
            kind: 'text',
            text: `⚠️ ${item.text?.trim() ? item.text : 'Codex 报告错误，但未提供错误详情'}`,
          })
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
