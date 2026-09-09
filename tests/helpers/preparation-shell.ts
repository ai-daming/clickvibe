/** Protocol fake for route tests: the existing gh/agent responses remain programmable.
 * Newly introduced local-Git observation commands use the real temporary repository;
 * worktree writes retain the fixture's response and update the fake registration view.
 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)
type Spec = { command: string; workdir?: string }
type Result = { exitCode: number | null; stdout: { text: string }; stderr?: { text?: string } }
async function physical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    if (dirname(path) === path) return path
    return join(await physical(dirname(path)), basename(path))
  }
}
const full = (value: string) => (/^[a-f0-9]{4,39}$/.test(value.trim()) ? value.trim().padEnd(40, '0') : value)
export function preparationShell<T extends Spec>(run: (spec: T) => Promise<Result>) {
  const registered = new Map<string, { branch: string; head: string }>()
  const repositories = new Set<string>()
  return async (spec: T): Promise<Result> => {
    const { command, workdir } = spec
    if (command === 'git rev-parse --git-common-dir' || command === 'git rev-parse --git-path hooks') {
      const args =
        command === 'git rev-parse --git-common-dir'
          ? ['rev-parse', '--git-common-dir']
          : ['rev-parse', '--git-path', 'hooks']
      if (command === 'git rev-parse --git-common-dir' && workdir) repositories.add(workdir)
      // Virtual detached-worktree fixtures inherit their one real repo's default hooks.
      // Actual hook behavior is tested with real Git worktrees, without this fallback.
      const result = await exec('git', args, { cwd: workdir }).catch(async (error) => {
        if (command !== 'git rev-parse --git-path hooks' || repositories.size !== 1) throw error
        return exec('git', args, { cwd: [...repositories][0] })
      })
      return { exitCode: 0, stdout: { text: result.stdout }, stderr: { text: result.stderr } }
    }
    const path = workdir ? await physical(workdir) : ''
    if (command === 'git rev-parse HEAD' && registered.has(path))
      return { exitCode: 0, stdout: { text: registered.get(path)!.head } }
    let result: Result
    if (/^git rev-parse (?:'[^']+'|HEAD)$/.test(command)) {
      try {
        result = await run({ ...spec, command: command.replace('git rev-parse ', 'git rev-parse --short ') })
      } catch {
        result = await run(spec)
      }
      return { ...result, stdout: { text: full(result.stdout.text) } }
    }
    result = await run(spec)
    if (command === 'git worktree list --porcelain') {
      const sections = result.stdout.text.split('\n\n').filter(Boolean)
      const entries = []
      for (const section of sections) {
        const match = section.match(/^worktree (.+)$/m)
        if (!match) continue
        const location = await physical(match[1])
        if (!registered.has(location)) entries.push(section)
      }
      for (const [location, entry] of registered)
        entries.push(`worktree ${location}\nHEAD ${entry.head}\nbranch refs/heads/${entry.branch}`)
      return { ...result, stdout: { text: entries.join('\n\n') } }
    }
    if (result.exitCode === 0 && command.startsWith('git worktree add ')) {
      const args = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1])
      if (args.length >= 2)
        registered.set(await physical(command.startsWith('git worktree add -b ') ? args[1] : args[0]), {
          branch: command.startsWith('git worktree add -b ') ? args[0] : args[1],
          head: args.length >= 3 ? full(args[2]) : 'abc1234'.padEnd(40, '0'),
        })
    }
    if (result.exitCode === 0 && command.startsWith('git switch ') && path) {
      const branch = command.match(/'([^']+)'/)?.[1]
      if (branch) registered.set(path, { branch, head: 'abc1234'.padEnd(40, '0') })
    }
    return result
  }
}
