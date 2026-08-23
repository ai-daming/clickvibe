/** Safe read-modify-write adapter for ~/.clickvibe/config.yaml project mappings. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMap, parseDocument } from 'yaml'

export async function addProjectRepoMapping(
  repoKey: string,
  projectPath: string,
): Promise<{ added: true } | { added: false; error: string }> {
  const path = join(homedir(), '.clickvibe', 'config.yaml')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
    raw = '{}\n'
  }

  const document = parseDocument(raw)
  if (document.errors.length > 0) {
    return { added: false, error: `config.yaml 无法解析: ${document.errors[0].message}` }
  }
  const repos = document.get('repos', true)
  if (repos !== undefined && !isMap(repos)) {
    return { added: false, error: 'config.yaml 的 repos 必须是 owner/repo 到路径的映射' }
  }
  if (document.getIn(['repos', repoKey]) !== undefined) {
    return { added: false, error: `项目 ${repoKey} 已配置，不会覆盖现有路径` }
  }

  if (repos === undefined) document.set('repos', document.createNode({}))
  document.setIn(['repos', repoKey], projectPath)
  const next = document.toString()
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (reason) {
    await unlink(temporary).catch(() => {})
    throw reason
  }
  return { added: true }
}
