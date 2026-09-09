/** Attach the shared v0.2 diagnostic stream to workflow rows consumed by the panel. */
import { githubWorkItemIdentity } from '../github/work-item-identity.ts'
import type { DiagnosticRecord } from '../infra/contracts.ts'
import { readDiagnosticRecords, readDiagnosticDetails } from '../infra/diagnostic-record.ts'

function identityFromIssueUrl(url: string) {
  const parsed = new URL(url)
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/)
  if (!match) return null
  return githubWorkItemIdentity({ instance: parsed.host, owner: match[1], repository: match[2], number: match[3] })
}

export async function attachWorkItemDiagnostics<T extends { url: string }>(
  workflows: readonly T[],
  root: string,
): Promise<Array<T & { diagnostics: Array<DiagnosticRecord & { details?: string }> }>> {
  return Promise.all(
    workflows.map(async (workflow) => {
      const identity = identityFromIssueUrl(workflow.url)
      const diagnostics = identity ? (await readDiagnosticRecords(root, identity)).slice(-20) : []
      const views = await Promise.all(
        diagnostics.map(async (record) => {
          const details = await readDiagnosticDetails(root, record)
          return details ? { ...record, details } : record
        }),
      )
      return { ...workflow, diagnostics: views }
    }),
  )
}
