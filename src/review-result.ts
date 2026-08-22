import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const REVIEW_RESULT_RELATIVE_PATH = '.clickvibe/review-result.json'
const MAX_REVIEW_RESULT_BYTES = 2 * 1024 * 1024

export interface ReviewResult {
  passed: boolean
  issues: string[]
}

export interface ResolvedReviewResult {
  result: ReviewResult
  source: 'file' | 'stdout-json' | 'stdout-verdict'
  fileError?: string
}

function parseMaterializedResult(raw: string): ReviewResult | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.passed !== 'boolean') return null
  if (!Array.isArray(record.issues) || !record.issues.every((issue) => typeof issue === 'string')) return null
  if (record.passed && record.issues.length > 0) return null
  return { passed: record.passed, issues: record.issues }
}

/** Remove the prior run's verdict before starting another review.
 *  Also creates the `.clickvibe` parent directory: brand-new worktrees have no
 *  such dir, and the review agent's write-tool often refuses to create parent
 *  directories itself — without this, materialization silently falls back to
 *  stdout parsing. The dir must exist before the agent starts. */
export async function clearReviewResultFile(worktree: string): Promise<void> {
  const dir = join(worktree, dirname(REVIEW_RESULT_RELATIVE_PATH))
  await mkdir(dir, { recursive: true })
  try {
    await unlink(join(dir, 'review-result.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function readMaterializedResult(worktree: string): Promise<
  | { result: ReviewResult; error?: never }
  | { result: null; error: string }
> {
  const path = join(worktree, REVIEW_RESULT_RELATIVE_PATH)
  try {
    const info = await lstat(path)
    if (!info.isFile()) return { result: null, error: '不是普通文件' }
    if (info.size > MAX_REVIEW_RESULT_BYTES) {
      return { result: null, error: `文件超过 ${MAX_REVIEW_RESULT_BYTES} 字节上限` }
    }
    const result = parseMaterializedResult(await readFile(path, 'utf8'))
    if (!result) return { result: null, error: 'JSON 损坏或 schema 非 {passed:boolean,issues:string[]}' }
    return { result }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { result: null, error: '文件不存在' }
    return { result: null, error: `读取失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Extract the final JSON verdict object from review display lines. */
export function extractReviewJson(lines: string[]): ReviewResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\{.*"passed".*\}/)
    if (!match) continue
    try {
      const obj = JSON.parse(match[0]) as { passed?: unknown; issues?: unknown }
      if (typeof obj.passed !== 'boolean') continue
      const issues = Array.isArray(obj.issues)
        ? obj.issues.filter((issue): issue is string => typeof issue === 'string')
        : []
      return { passed: obj.passed, issues }
    } catch {
      // Keep searching older lines to preserve the existing stdout fallback.
    }
  }
  return null
}

function reviewVerdict(lines: string[]): { passed: boolean } {
  let sawFail = false
  let sawPass = false
  for (const line of lines) {
    const text = line.trim()
    if (text.includes('❌') && /发现|存在|问题|Review/.test(text)) sawFail = true
    if (text.includes('✅') && !/本轮完成|会话结束/.test(text)) sawPass = true
    if (/Review\s*通过|未发现问题|无问题/.test(text)) sawPass = true
  }
  return { passed: !sawFail && sawPass }
}

function extractIssues(lines: string[]): string[] {
  const issues: string[] = []
  let verdictIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('❌')) verdictIndex = i
  }
  if (verdictIndex === -1) return []
  const verdict = lines[verdictIndex]
  const rest = verdict.slice(verdict.indexOf('❌') + 1)
  const parts = rest.split(/(?=\d+\.\s)/).filter((part) => /^\d+\./.test(part.trim()))
  if (parts.length > 0) {
    for (const part of parts) {
      const issue = part.replace(/^\d+\.\s*/, '').trim()
      if (issue !== '') issues.push(issue)
    }
  } else {
    for (let i = verdictIndex + 1; i < lines.length; i++) {
      const text = lines[i].trim()
      if (text === '' || /^✅|^⚠️|^🚀|^💭|^🔧|^\[clickvibe\]|本轮完成|会话结束/.test(text)) break
      issues.push(text)
    }
  }
  return issues.slice(0, 20)
}

/** Resolve a verdict from the durable file first, then preserve both stdout fallbacks. */
export async function loadReviewResult(worktree: string, lines: string[]): Promise<ResolvedReviewResult> {
  const materialized = await readMaterializedResult(worktree)
  if (materialized.result) return { result: materialized.result, source: 'file' }

  const json = extractReviewJson(lines)
  if (json) return { result: json, source: 'stdout-json', fileError: materialized.error }

  const passed = reviewVerdict(lines).passed
  return {
    result: { passed, issues: passed ? [] : extractIssues(lines) },
    source: 'stdout-verdict',
    fileError: materialized.error,
  }
}
