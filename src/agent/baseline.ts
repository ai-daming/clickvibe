/** Pure baseline rules shared by agent worktree creation and prompts. */

const ORIGIN_PREFIX = 'origin/'

export function requestedRemoteBase(value: unknown): string {
  const ref = String(value ?? '').trim() || 'origin/HEAD'
  if (!ref.startsWith(ORIGIN_PREFIX)) throw new Error('开发基线只接受 fetch 后的 origin/* 远端分支')
  const branch = ref.slice(ORIGIN_PREFIX.length)
  if (
    branch === '' ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error('开发基线不是有效的 origin/* 远端分支')
  }
  return ref
}

export function frozenRemoteBase(baseRef: string | null | undefined): string | null {
  const raw = String(baseRef ?? '')
    .split(/\s+@\s+/, 1)[0]
    .trim()
  if (raw === '') return null
  return requestedRemoteBase(raw.replace(/^refs\/remotes\//, ''))
}

/** Extract the immutable fork commit, usable after the remote branch is deleted. */
export function frozenBaseHash(baseRef: string | null | undefined): string | null {
  const match = String(baseRef ?? '').match(/\s+@\s+([0-9a-f]{4,64})\s*$/i)
  return match?.[1] ?? null
}

export function resolveSelectedRemoteBase(input: {
  requested: unknown
  frozen: string | null | undefined
  defaultRemoteBase: string
}): string {
  const frozen = frozenRemoteBase(input.frozen)
  if (frozen !== null && (input.requested === undefined || input.requested === null || input.requested === '')) {
    return frozen
  }
  const requested = requestedRemoteBase(input.requested)
  const selected = requested === 'origin/HEAD' ? requestedRemoteBase(input.defaultRemoteBase) : requested
  if (frozen !== null && frozen !== selected) {
    throw new Error(`开发基线已定格为 ${frozen},拒绝改为 ${selected}`)
  }
  return frozen ?? selected
}
