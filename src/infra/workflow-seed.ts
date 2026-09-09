/** Initial metadata only; callers cannot seed a running task or an automatic-run grant. */
import { basename, join } from 'node:path'
import type { IssueWorkflow } from './state.ts'
import { issueKey } from './state-layout.ts'
export function workflowSeed(repoKey: string, number: string, repoPath: string, worktreeRoot: string): IssueWorkflow {
  const project = basename(repoPath),
    branch = `${project}-issue-${number}`
  return {
    key: issueKey(repoKey, number),
    url: `https://github.com/${repoKey}/issues/${number}`,
    repoKey,
    branch,
    worktree: join(worktreeRoot, project, branch),
    stage: 'idle',
    devAgent: null,
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: null,
    updatedAt: 0,
    events: [],
  }
}
