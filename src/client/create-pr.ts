import { apiCall } from './domain.ts'

export async function createPrFromClient(input: {
  url: string
  authorize: () => Promise<{ authorizationId: string; authorizationDigest: string } | null>
  setBusy: (value: string | null) => void
  setError: (value: string | null) => void
  refresh: () => Promise<void>
}): Promise<void> {
  input.setBusy('creating-pr')
  input.setError(null)
  try {
    const authorization = await input.authorize()
    if (!authorization) return
    const result = await apiCall<{ ok: true; prNumber: string; created: boolean } | { ok: false; error: string }>(
      'create-pr',
      { url: input.url, ...authorization },
    )
    if (!result.ok) throw new Error(result.error)
    await input.refresh()
  } catch (reason) {
    input.setError(String(reason instanceof Error ? reason.message : reason))
  } finally {
    input.setBusy(null)
  }
}
