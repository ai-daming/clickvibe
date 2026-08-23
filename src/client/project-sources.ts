/** Pure project-source union plus the optional DSH workspace-list adapter. */
import type { ProjectOption } from './domain.ts'

interface WorkspaceListSnapshot {
  items?: readonly { path?: unknown }[]
  state?: string
  error?: unknown
}

export interface DshWorkspaceSource {
  getSnapshot(): WorkspaceListSnapshot
  subscribe(listener: () => void): () => void
}

export function resolveDshWorkspaceSource(ctx: { get(name: string): unknown }): DshWorkspaceSource | null {
  const service = ctx.get('workspaces') as { list?: DshWorkspaceSource } | null | undefined
  return service?.list ?? null
}

export function readDshWorkspaceSnapshot(source: DshWorkspaceSource): { paths: string[]; error: string | null } {
  try {
    const snapshot = source.getSnapshot()
    if (snapshot.state === 'error') {
      return { paths: [], error: `DSH 项目读取失败: ${errorMessage(snapshot.error)}` }
    }
    const paths = (snapshot.items ?? [])
      .map((item) => (typeof item.path === 'string' ? normalizeProjectPath(item.path) : ''))
      .filter((path) => path !== '')
    return { paths: [...new Set(paths)], error: null }
  } catch (reason) {
    return { paths: [], error: `DSH 项目读取失败: ${errorMessage(reason)}` }
  }
}

export function mergeProjectSources(configured: ProjectOption[], dshPaths: readonly string[]): ProjectOption[] {
  const configuredPaths = new Set(configured.map((project) => normalizeProjectPath(project.path)))
  const projects = configured.map((project) => ({ ...project, configured: true }))
  for (const rawPath of dshPaths) {
    const path = normalizeProjectPath(rawPath)
    if (path === '' || configuredPaths.has(path)) continue
    configuredPaths.add(path)
    projects.push({ repoKey: `dsh:${path}`, path, available: true, configured: false })
  }
  return projects
}

export function deriveProjectSelection(
  project: ProjectOption,
): { loadRepository: true } | { loadRepository: false; repoAdvance: null; repoSyncMessage: null } {
  return project.configured === false
    ? { loadRepository: false, repoAdvance: null, repoSyncMessage: null }
    : { loadRepository: true }
}

function normalizeProjectPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized === '' && /^[\\/]+$/.test(path.trim()) ? path.trim().slice(0, 1) : normalized
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message)
  return String(reason ?? '未知错误')
}
