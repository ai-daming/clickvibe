import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { assessmentBasis, assessmentGit, assessmentSkill, readAssessmentFile } from '../src/infra/assessment-source.ts'
import { executeAssessment } from '../src/infra/assessment-harness.ts'
import { recoveryHome } from './helpers/recovery-home.ts'
import { assessmentReport, assessmentView } from '../src/workflow/assessment-policy.ts'

test('assessment reads frozen Git objects instead of subsequently edited files', async () => {
  const { home, repositories } = await recoveryHome(['o/r'])
  const path = repositories['o/r']
  try {
    await writeFile(join(path, 'README.md'), 'accepted design')
    await assessmentGit(path, ['add', 'README.md'])
    await assessmentGit(path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'test source',
    ])
    const oid = (await assessmentGit(path, ['rev-parse', 'HEAD'])).trim()
    await writeFile(join(path, 'README.md'), 'uncommitted changes')
    assert.equal(await readAssessmentFile(path, oid, 'README.md'), 'accepted design')
    for (const file of ['', '../outside', '/etc/passwd', '.env', '.env.local', 'key.pem', '.git/config', 'a\\b'])
      await assert.rejects(readAssessmentFile(path, oid, file), /只允许/)
    await assert.rejects(readAssessmentFile(path, 'HEAD', 'README.md'), /只允许/)
    const skill = await assessmentSkill()
    assert.match(skill.text, /Design Readiness Contract/)
    assert.match(skill.text, /VerifiedDesignReceipt/)
    assert.equal(skill.hash.length, 64)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('assessment read tools project the real content the model receives', async () => {
  const { home, repositories } = await recoveryHome(['o/r'])
  const path = repositories['o/r']
  try {
    await writeFile(join(path, 'README.md'), 'accepted design')
    await assessmentGit(path, ['add', 'README.md'])
    await assessmentGit(path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'test source',
    ])
    const baseOid = (await assessmentGit(path, ['rev-parse', 'HEAD'])).trim()
    const registered = new Map<
      string,
      {
        output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
        execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown>
      }
    >()
    const host = {
      llm: { resolveCallConfig: async () => undefined },
      agents: {
        async create(options: { sessionId: string; setup(scope: unknown): void }) {
          options.setup({
            tools: {
              presentAs: () => undefined,
              restrict: () => undefined,
              guard: () => undefined,
              register: (tool: { name: string }) => registered.set(tool.name, tool as never),
            },
          })
          return {
            agent: {
              id: options.sessionId,
              followup: () => undefined,
              async whenIdle() {
                // The host projects a successful body value as render(callArguments, value).
                const args = { path: 'README.md' }
                const read = registered.get('assessment_read_file')!
                const content = await read.execute(args, { signal: new AbortController().signal })
                assert.equal(content, 'accepted design')
                assert.deepEqual(read.output.render(args, content), [{ type: 'text', text: 'accepted design' }])
                const list = registered.get('assessment_list_files')!
                const listing = await list.execute({}, { signal: new AbortController().signal })
                assert.deepEqual(list.output.render({}, listing), [{ type: 'text', text: listing }])
              },
              cancel: () => undefined,
            },
            dispose: async () => undefined,
          }
        },
      },
      sessionPersistence: {
        open: async () => ({ read: async () => ({ events: [] }), close: async () => undefined }),
      },
    }
    const run = { id: 'run', sessionId: 'session', messageId: 'message', input: { repoPath: path, baseOid } }
    await executeAssessment(host as never, run as never, 'Use impl-gate.', new AbortController().signal)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('checkbox changes preserve assessment basis while requirements and code invalidate it', () => {
  const basis = (body: string, oid = 'a') => assessmentBasis(body, 'canonical', oid, 'skill')
  assert.equal(basis('## 验收标准\r\n- [ ] 完成  \r\n'), basis('## 验收标准\n- [x] 完成'))
  assert.notEqual(basis('目标 A'), basis('目标 B'))
  assert.notEqual(basis('目标 A'), basis('目标 A', 'b'))
})

test('every original gate verdict has advisory presentation without changing development state', () => {
  for (const verdict of [
    'READY',
    'NEEDS_EVIDENCE',
    'NEEDS_DECISION',
    'DESIGN_REQUIRED',
    'AWAITING_ACCEPTANCE',
    'REFRAME',
  ]) {
    const report = assessmentReport(`Implementation Gate: ${verdict}\nWork: o/r#1\n说明`)
    const run = { phase: 'completed', input: { basis: 'b' }, verdict: report.verdict }
    const view = assessmentView(run as never, 'b')
    assert.equal(view.discussion, !['READY', 'NEEDS_EVIDENCE'].includes(verdict))
    assert.equal(assessmentView(run as never, 'changed').discussion, view.discussion)
    assert.equal(assessmentView(run as never, 'changed').label, '评估依据已变化')
  }
  for (const phase of ['queued', 'running', 'failed', 'interrupted', 'cancelled'])
    assert.equal(assessmentView({ phase, input: { basis: 'b' } } as never, 'b').discussion, false)
  assert.throws(() => assessmentReport('Implementation Gate: UNKNOWN\nWork: x\nexplain'), /结论/)
})

test('invalid frozen commit is rejected before calling the assessment host', async () => {
  for (const baseOid of ['HEAD', '--all', '', 'a'.repeat(39)]) {
    await assert.rejects(
      executeAssessment({} as never, { input: { baseOid } } as never, '', new AbortController().signal),
      /只允许读取评估提交/,
    )
  }
})
