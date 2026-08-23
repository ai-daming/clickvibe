export interface RestoreAuthorizationTarget {
  branch: string
  hash: string
}

export interface MergeAuthorizationTarget {
  prNumber: string
  branch: string
  head: string
  baseRef: string
  baseSha: string
  mergeFlag: '--merge'
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

export function mergeAuthorizationTarget(value: unknown): MergeAuthorizationTarget {
  const raw = value as Record<string, unknown>
  const target = {
    prNumber: String(raw?.prNumber ?? '').trim(),
    branch: String(raw?.branch ?? '').trim(),
    head: String(raw?.head ?? '').trim(),
    baseRef: String(raw?.baseRef ?? '').trim(),
    baseSha: String(raw?.baseSha ?? '').trim(),
  }
  if (
    !/^\d+$/.test(target.prNumber) ||
    target.branch === '' ||
    !/^[0-9a-f]{7,64}$/i.test(target.head) ||
    !isValidGitBranchName(target.baseRef) ||
    !/^[0-9a-f]{7,64}$/i.test(target.baseSha) ||
    raw?.mergeFlag !== '--merge'
  ) {
    throw new Error('合并授权目标无效')
  }
  return { ...target, mergeFlag: '--merge' }
}
