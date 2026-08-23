import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const REVIEW_RESULT_RELATIVE_PATH = '.clickvibe/review-result.json'
const MAX_REVIEW_RESULT_BYTES = 2 * 1024 * 1024

export interface ReviewResult {
  passed: boolean
  issues: string[]
}

export interface ResolvedReviewResult {
  result: ReviewResult | null
  source: 'file' | 'stdout-json' | 'stdout-verdict' | 'parse-error'
  fileError?: string
  parseError?: string
}

type ParsedReviewResult = { result: ReviewResult; error?: never } | { result: null; error: string }

function validateReviewResult(value: unknown): ParsedReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { result: null, error: 'schema 非 {passed:boolean,issues:string[]}' }
  }
  const record = value as Record<string, unknown>
  if (typeof record.passed !== 'boolean') return { result: null, error: 'passed 不是 boolean' }
  if (!Array.isArray(record.issues) || !record.issues.every((issue) => typeof issue === 'string')) {
    return { result: null, error: 'issues 不是 string[]' }
  }
  if (record.passed && record.issues.length > 0) return { result: null, error: '通过结论不能包含问题' }
  if (!record.passed && record.issues.length === 0) return { result: null, error: '未通过结论必须包含至少一个问题' }
  return { result: { passed: record.passed, issues: record.issues } }
}

function parseMaterializedResult(raw: string): ParsedReviewResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { result: null, error: 'JSON 损坏' }
  }
  return validateReviewResult(value)
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

async function readMaterializedResult(
  worktree: string,
): Promise<{ result: ReviewResult; error?: never } | { result: null; error: string }> {
  const path = join(worktree, REVIEW_RESULT_RELATIVE_PATH)
  try {
    const info = await lstat(path)
    if (!info.isFile()) return { result: null, error: '不是普通文件' }
    if (info.size > MAX_REVIEW_RESULT_BYTES) {
      return { result: null, error: `文件超过 ${MAX_REVIEW_RESULT_BYTES} 字节上限` }
    }
    return parseMaterializedResult(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { result: null, error: '文件不存在' }
    return { result: null, error: `读取失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Extract the final JSON verdict object from review display lines. */
export function extractReviewJson(lines: string[]): ParsedReviewResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\{.*"passed".*\}/)
    if (!match) continue
    try {
      return validateReviewResult(JSON.parse(match[0]))
    } catch {
      // Keep searching older lines to preserve the existing stdout fallback.
    }
  }
  return null
}

function reviewVerdict(lines: string[]): { passed: boolean } {
  let sawFail = false
  let sawPass = false
  const evidence = lines.map((line) => line.trim()).filter((text) => text !== '' && !text.startsWith('[clickvibe]'))
  for (const text of evidence) {
    if (text.includes('❌') && /发现|存在|问题|Review/.test(text)) sawFail = true
    if (text.includes('✅') && !/本轮完成|会话结束/.test(text)) sawPass = true
    if (/Review\s*通过|未发现问题|无问题/.test(text)) sawPass = true
  }
  // Claude's result event is generic, so accept it only as the current run's
  // final agent evidence; an older session-end line in the persistent log is stale.
  if (evidence.at(-1)?.includes('✅ 会话结束')) sawPass = true
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
  if (materialized.error.includes('未通过结论必须')) {
    return { result: null, source: 'parse-error', parseError: materialized.error, fileError: materialized.error }
  }

  const json = extractReviewJson(lines)
  if (json?.result) return { result: json.result, source: 'stdout-json', fileError: materialized.error }
  if (json?.error) {
    return { result: null, source: 'parse-error', parseError: json.error, fileError: materialized.error }
  }

  const passed = reviewVerdict(lines).passed
  const issues = passed ? [] : extractIssues(lines)
  if (!passed && issues.length === 0) {
    return {
      result: null,
      source: 'parse-error',
      parseError: 'stdout 未通过结论没有可执行的问题列表',
      fileError: materialized.error,
    }
  }
  return {
    result: { passed, issues },
    source: 'stdout-verdict',
    fileError: materialized.error,
  }
}
