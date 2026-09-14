/** Frozen Git-object reads and the complete bundled implementation-gate skill. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { assessmentHash } from './assessment-store.ts'
const exec = promisify(execFile)
export async function assessmentGit(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await exec('git', ['-C', path, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, signal })).stdout
}
export async function readAssessmentFile(path: string, oid: string, file: string, signal?: AbortSignal) {
  if (
    !/^[a-f0-9]{40}$/.test(oid) ||
    !file ||
    file.startsWith('/') ||
    file.includes('..') ||
    file.includes('\\') ||
    /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$))|\.(?:pem|key)$/i.test(file)
  )
    throw new Error('只允许读取评估提交中的仓库文件')
  return assessmentGit(path, ['show', `${oid}:${file}`], signal)
}
export async function assessmentSkill() {
  const files = ['SKILL.md', 'references/design-readiness-contract.md', 'references/examples.md']
  const root = new URL('../../skills/impl-gate/', import.meta.url)
  const bundled = new URL('../skills/impl-gate/', import.meta.url)
  const directory = existsSync(new URL('SKILL.md', bundled)) ? bundled : root
  const parts = await Promise.all(
    files.map(async (file) => `# ${file}\n${await readFile(new URL(file, directory), 'utf8')}`),
  )
  return { text: parts.join('\n\n'), hash: assessmentHash(parts.join('\n\n')) }
}
export function assessmentBasis(body: string, fingerprint: string, oid: string, skillHash: string) {
  const normalized = body
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
    .replace(/^(\s*-\s*)\[[ xX]\]/gm, '$1[ ]')
  return assessmentHash(JSON.stringify([1, fingerprint, normalized, oid, skillHash]))
}
