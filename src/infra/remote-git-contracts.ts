import type { RemoteGitScope, RemoteGitTerminalOutcome } from './remote-git-lifecycle.ts'

export interface RemoteGitWriteAttempt {
  attemptId: string
  scope: RemoteGitScope
  operationKind: 'push' | 'push-set-upstream' | 'force-with-lease' | 'delete'
  destinationRef: string
  expectedOid: string | null
  expectedRemoteOid: string | null
  status: 'prepared' | 'confirmed' | 'failed' | 'unknown'
  preparedAt: string
  diagnosticRef?: string
}

export interface RemoteGitOutcome {
  outcome: RemoteGitTerminalOutcome
  flightId: string
  attemptId?: string
  output?: string
  readback?: string
  error?: string
}
