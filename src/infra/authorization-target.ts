export interface RestoreAuthorizationTarget {
  branch: string
  hash: string
}

/** Normalize the exact branch/hash pair bound into a restore authorization digest. */
export function restoreAuthorizationTarget(value: unknown): RestoreAuthorizationTarget {
  const raw = value as Record<string, unknown>
  const branch = String(raw?.branch ?? '').trim()
  const hash = String(raw?.hash ?? '').trim()
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || !/^[0-9a-f]{4,64}$/i.test(hash)) {
    throw new Error('恢复基线授权目标无效')
  }
  return { branch, hash }
}
