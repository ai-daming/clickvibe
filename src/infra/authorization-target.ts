export interface RestoreAuthorizationTarget {
  branch: string
  hash: string
}

/** Mirror git-check-ref-format branch rules without restricting valid Unicode names. */
export function isValidGitBranchName(branch: string): boolean {
  if (branch === '' || branch === '@' || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
    return false
  }
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false
  if (
    [...branch].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 32 || code === 127 || '~^:?*[\\'.includes(character)
    })
  ) {
    return false
  }
  return branch
    .split('/')
    .every((component) => component !== '' && !component.startsWith('.') && !component.endsWith('.lock'))
}

/** Normalize the exact branch/hash pair bound into a restore authorization digest. */
export function restoreAuthorizationTarget(value: unknown): RestoreAuthorizationTarget {
  const raw = value as Record<string, unknown>
  const branch = String(raw?.branch ?? '').trim()
  const hash = String(raw?.hash ?? '').trim()
  if (!isValidGitBranchName(branch) || !/^[0-9a-f]{4,64}$/i.test(hash)) {
    throw new Error('恢复基线授权目标无效')
  }
  return { branch, hash }
}
