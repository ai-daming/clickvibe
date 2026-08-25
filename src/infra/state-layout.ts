import { Buffer } from 'node:buffer'
import { join, relative, sep } from 'node:path'

export interface WorkflowStorageIdentity {
  key: string
  repoKey: string
  url: string
}

export interface IssueCoordinates {
  owner: string
  repo: string
  issue: string
}

const GITHUB_COMPONENT = /^[A-Za-z0-9_.-]+$/
const ISSUE_NUMBER = /^[1-9]\d*$/
const TASK_ID = /^[A-Za-z0-9_.-]+$/

function validGithubComponent(value: string): boolean {
  return GITHUB_COMPONENT.test(value) && value !== '.' && value !== '..'
}

export function issueCoordinates(workflow: WorkflowStorageIdentity): IssueCoordinates {
  const slash = workflow.repoKey.indexOf('/')
  const owner = workflow.repoKey.slice(0, slash)
  const repo = workflow.repoKey.slice(slash + 1)
  const match = workflow.url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/)
  const issue = match?.[1] ?? ''
  if (!validGithubComponent(owner) || !validGithubComponent(repo) || !ISSUE_NUMBER.test(issue)) {
    throw new Error(`invalid workflow storage identity: ${workflow.repoKey} ${workflow.url}`)
  }
  return { owner, repo, issue }
}

export function issueDirectory(root: string, owner: string, repo: string, issue: string): string {
  if (!validGithubComponent(owner) || !validGithubComponent(repo) || !ISSUE_NUMBER.test(issue)) {
    throw new Error('invalid issue coordinates')
  }
  return join(root, owner, repo, `issue-${issue}`)
}

export function parseIssueDirectory(root: string, directory: string): IssueCoordinates | null {
  const parts = relative(root, directory).split(sep)
  if (parts.length !== 3) return null
  const [owner, repo, issuePart] = parts
  const issue = issuePart.match(/^issue-([1-9]\d*)$/)?.[1] ?? ''
  if (!validGithubComponent(owner) || !validGithubComponent(repo) || !ISSUE_NUMBER.test(issue)) return null
  return { owner, repo, issue }
}

export function workflowPath(root: string, workflow: WorkflowStorageIdentity): string {
  const { owner, repo, issue } = issueCoordinates(workflow)
  return join(issueDirectory(root, owner, repo, issue), 'workflow.json')
}

export function taskStartTimestamp(taskId: string): string {
  const milliseconds = Number(taskId.match(/^[a-z]+-(\d+)-/)?.[1])
  const date = Number.isSafeInteger(milliseconds) ? new Date(milliseconds) : new Date(0)
  return date.toISOString().replace(/[:.]/g, '-')
}

export function taskLogPath(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: 'dev' | 'review',
  taskId: string,
): string {
  if (!TASK_ID.test(taskId)) throw new Error('invalid task id')
  return join(workflowPath(root, workflow), '..', kind, `${taskStartTimestamp(taskId)}--${taskId}.jsonl`)
}

export function issueKey(repoKey: string, number: string): string {
  if (!ISSUE_NUMBER.test(number)) throw new Error('invalid issue number')
  return `issue-${Buffer.from(repoKey, 'utf8').toString('base64url')}-${number}`
}

export function parseIssueKey(key: unknown): { owner: string; repo: string; issue: string } | null {
  if (typeof key !== 'string') return null
  const match = key.match(/^issue-([A-Za-z0-9_-]+)-([1-9]\d*)$/)
  if (!match) return null
  try {
    const repoKey = Buffer.from(match[1], 'base64url').toString('utf8')
    const slash = repoKey.indexOf('/')
    if (slash < 0 || repoKey.indexOf('/', slash + 1) !== -1) return null
    const owner = repoKey.slice(0, slash)
    const repo = repoKey.slice(slash + 1)
    if (!validGithubComponent(owner) || !validGithubComponent(repo)) return null
    return { owner, repo, issue: match[2] }
  } catch {
    return null
  }
}

export function diagnosticLogPath(root: string, workflowKey?: unknown): string {
  const coordinates = parseIssueKey(workflowKey)
  return coordinates
    ? join(issueDirectory(root, coordinates.owner, coordinates.repo, coordinates.issue), 'diagnostics.jsonl')
    : join(root, 'diagnostics.jsonl')
}

export function legacyIssueKey(key: string): string | null {
  const coordinates = parseIssueKey(key)
  return coordinates ? `${coordinates.owner}-${coordinates.repo}-${coordinates.issue}` : null
}
