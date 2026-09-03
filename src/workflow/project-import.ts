/** DSH-project import use case: validate git origin, then refuse the v0.1 repos write. */
import type { Context } from '@deepseek-ai/cordis'
import { runCommand } from '../infra/runtime.ts'

export type ProjectImportResult = { ok: true; repoKey: string } | { ok: false; error: string }

export function parseGithubRepoKey(remote: string): string | null {
  const value = remote.trim().replace(/\/+$/, '')
  const scp = value.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  if (scp) return `${scp[1]}/${scp[2]}`
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/i, '')
    return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) && owner !== '' && repo !== '' ? `${owner}/${repo}` : null
  } catch {
    return null
  }
}

export async function importDshProject(ctx: Context, projectPath: string): Promise<ProjectImportResult> {
  const path = projectPath.trim()
  if (path === '') return { ok: false, error: 'DSH 项目路径为空，无法导入' }
  let remote: string
  try {
    remote = await runCommand(ctx, 'git remote get-url origin', {
      workdir: path,
      timeoutMs: 10_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: path },
    })
  } catch (reason) {
    return {
      ok: false,
      error: `目录 ${path} 不是可导入的 git 仓库，或没有 origin: ${errorMessage(reason)}`,
    }
  }
  const repoKey = parseGithubRepoKey(remote)
  if (!repoKey) return { ok: false, error: 'origin 不是可识别的 GitHub 仓库地址' }
  return {
    ok: false,
    error: `项目 ${repoKey} 的 v0.1 repos 写入已随 v0.2 clean break 废弃（ADR-0009、处置表 A2）；v0.2 项目新增入口是显式非目标`,
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
