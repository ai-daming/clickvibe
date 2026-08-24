import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

// Workflow-state persistence boundary gate (docs/fix-discipline.md 机器门禁):
// rule 1 — only the persistence module may resolve workflow state file paths;
// rule 2 — the persistence module is reachable only via the state facade and
//          the pure ownership selector;
// rule 3 — snapshot saves must be revision-conditional (no single-arg calls).

const root = process.cwd()

async function collect(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(relative)))
    else if (/\.tsx?$/.test(entry.name)) files.push(relative)
  }
  return files
}

const failures = []
for (const file of await collect('src')) {
  const contents = await readFile(path.join(root, file), 'utf8')

  // Rule 1: workflow state path resolution stays inside the persistence layer
  // (state-layout.ts defines it; state.ts facades it; persistence writes it).
  const pathAllowed =
    file === 'src/infra/workflow-persistence.ts' ||
    file === 'src/infra/state-layout.ts' ||
    file === 'src/infra/state.ts'
  if (/workflowPath|workflowStatePath/.test(contents) && !pathAllowed) {
    failures.push(
      `${file}: workflow state path may only be resolved in the persistence layer (workflow-persistence/state-layout/state facade)`,
    )
  }

  // Rule 2: the persistence module is imported only by the facade and the
  // pure current-task selector (no write access from upper layers).
  if (/from '[./]*(infra\/)?workflow-persistence/.test(contents)) {
    const allowed = file === 'src/infra/state.ts' || file === 'src/infra/task-ownership.ts'
    if (!allowed) failures.push(`${file}: import workflow-persistence directly (must go through src/infra/state.ts)`)
  }

  // Rule 3: snapshot saves carry an expected revision — a bare single-argument
  // call would be an unconditional last-writer-wins overwrite.
  for (const match of contents.matchAll(
    /\b(saveWorkflow(?:ForTask)?|claimWorkflowTask|mutateWorkflowForTask)\(\s*[^,()]*\s*\)/g,
  )) {
    failures.push(`${file}: ${match[1]} called without expected-revision/capability argument`)
  }
}

if (failures.length > 0) {
  console.error(`State-write gate failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('State-write gate passed.')
}
