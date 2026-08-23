import type { Context } from '@deepseek-ai/cordis'
import { githubRest } from './rest.ts'

/** Detect the open PR created from one branch. */
export async function detectLinkedPr(ctx: Context, repoKey: string, branch: string): Promise<string | null> {
  try {
    const owner = repoKey.split('/')[0]
    const prs = await githubRest(ctx).json<Array<{ number?: number }>>(
      `repos/${repoKey}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
    )
    return prs[0]?.number === undefined ? null : String(prs[0].number)
  } catch {
    return null
  }
}
