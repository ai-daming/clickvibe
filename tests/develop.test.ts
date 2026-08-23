import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentChunk } from '../src/agent/agent-stream.ts'
import {
  AuthorizationStore,
  LineLog,
  RESUME_REJECT_WINDOW_MS,
  authorizationDigest,
  buildFreshAgentCommand,
  buildResumeAgentCommand,
  buildWorktreeAddCommand,
  decideWorktreeRecovery,
  makeAuthorizationInput,
  parseAgent,
  parseGithubUrl,
  shellQuote,
  shouldFallbackFromExactResume,
  parseDependencies,
  validatePrivilegedRequest,
} from '../src/agent/develop.ts'

test('parseAgent accepts only the three supported agents', () => {
  assert.equal(parseAgent('codex'), 'codex')
  assert.equal(parseAgent('CLAUDE'), 'claude')
  assert.equal(parseAgent(' dryrun '), 'dryrun')
  assert.equal(parseAgent(undefined), 'codex')
  assert.throws(() => parseAgent('other'), /不支持的 agent/)
})

test('parseGithubUrl accepts exact issue and PR URLs only', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/ai-daming/clickvibe/issues/1'), {
    kind: 'issue',
    owner: 'ai-daming',
    repo: 'clickvibe',
    number: '1',
  })
  assert.equal(parseGithubUrl('https://github.com/a/b/issues/1/extra'), null)
  assert.equal(parseGithubUrl('https://evil.example/a/b/issues/1'), null)
})

test('shellQuote prevents POSIX shell expansion', () => {
  assert.equal(shellQuote('/tmp/simple'), "'/tmp/simple'")
  assert.equal(shellQuote("/tmp/a'b$(touch nope)"), "'/tmp/a'\\''b$(touch nope)'")
})

test('resume commands continue the exact session and use a valid codex fallback', () => {
  assert.equal(
    buildResumeAgentCommand('codex', 'thread-123'),
    `codex exec -c 'approval_policy="never"' -s danger-full-access resume 'thread-123' --json -`,
  )
  assert.equal(
    buildResumeAgentCommand('codex', null),
    `codex exec -c 'approval_policy="never"' -s danger-full-access resume --last --json -`,
  )
  assert.equal(
    buildResumeAgentCommand('claude', 'session-123'),
    `claude -p --resume 'session-123' --dangerously-skip-permissions --verbose --output-format stream-json`,
  )
})

test('fresh commands never retry the stale session', () => {
  assert.equal(
    buildFreshAgentCommand('codex'),
    `codex exec -c 'approval_policy="never"' -s danger-full-access --json -`,
  )
  assert.equal(
    buildFreshAgentCommand('claude'),
    'claude -p --dangerously-skip-permissions --verbose --output-format stream-json',
  )
})

test('only a quick exact-resume failure before session initialization falls back', () => {
  const rejected = {
    hadExactSessionId: true,
    status: 'failed' as const,
    exitCode: 1,
    elapsedMs: RESUME_REJECT_WINDOW_MS,
    sawSessionId: false,
  }
  assert.equal(shouldFallbackFromExactResume(rejected), true)
  assert.equal(
    shouldFallbackFromExactResume({ ...rejected, hadExactSessionId: false }),
    false,
    'fresh retry cannot recurse',
  )
  assert.equal(
    shouldFallbackFromExactResume({ ...rejected, sawSessionId: true }),
    false,
    'initialized session failed later',
  )
  assert.equal(
    shouldFallbackFromExactResume({ ...rejected, elapsedMs: RESUME_REJECT_WINDOW_MS + 1 }),
    false,
    'long task failure',
  )
  assert.equal(shouldFallbackFromExactResume({ ...rejected, status: 'stopped' }), false, 'user stop')
  assert.equal(shouldFallbackFromExactResume({ ...rejected, exitCode: 0 }), false, 'successful resume')
})

test('LineLog buffers complete lines and flushes a final fragment', () => {
  const log = new LineLog(10)
  log.appendChunk('one\ntw')
  assert.deepEqual(log.read(0), { cursor: 1, lines: ['one'], truncated: false })
  log.appendChunk('o\nthree\r\n')
  log.appendChunk('last')
  log.flush()
  assert.deepEqual(log.read(1), {
    cursor: 4,
    lines: ['two', 'three', 'last'],
    truncated: false,
  })
})

test('LineLog keeps readers independent and reports truncation', () => {
  const log = new LineLog(3)
  log.appendLine('one')
  log.appendLine('two')
  assert.deepEqual(log.read(0).lines, ['one', 'two'])
  assert.deepEqual(log.read(0).lines, ['one', 'two'])
  log.appendLine('three')
  log.appendLine('four')
  assert.deepEqual(log.read(0), {
    cursor: 4,
    lines: ['[clickvibe] 较早日志已截断', 'two', 'three', 'four'],
    truncated: true,
  })
})

test('worktree recovery creates or reuses the intended branch', () => {
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: false,
      pathEmpty: false,
      registeredBranch: null,
      branchExists: false,
      branchWorktree: null,
    }),
    { kind: 'add-new-branch' },
  )
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: true,
      registeredBranch: null,
      branchExists: true,
      branchWorktree: null,
    }),
    { kind: 'add-existing-branch' },
  )
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: false,
      registeredBranch: 'clickvibe-issue-1',
      branchExists: true,
      branchWorktree: '/target',
    }),
    { kind: 'reuse' },
  )
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: false,
      registeredBranch: 'HEAD',
      branchExists: false,
      branchWorktree: null,
    }),
    { kind: 'attach-detached' },
  )
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: false,
      registeredBranch: 'HEAD',
      branchExists: true,
      branchWorktree: null,
    }),
    { kind: 'attach-existing' },
  )
})

test('worktree recovery fails closed for conflicting partial states', () => {
  assert.match(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: false,
      registeredBranch: null,
      branchExists: false,
      branchWorktree: null,
    }).reason ?? '',
    /非空目录/,
  )
  assert.match(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: true,
      pathEmpty: false,
      registeredBranch: 'other',
      branchExists: true,
      branchWorktree: null,
    }).reason ?? '',
    /其他分支/,
  )
  assert.match(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: false,
      pathEmpty: false,
      registeredBranch: null,
      branchExists: true,
      branchWorktree: '/elsewhere',
    }).reason ?? '',
    /其他 worktree/,
  )
})

test('stale registration with a missing branch is rebuilt from the explicit remote base', () => {
  assert.deepEqual(
    decideWorktreeRecovery({
      targetBranch: 'clickvibe-issue-1',
      pathExists: false,
      pathEmpty: false,
      registeredBranch: 'clickvibe-issue-1',
      branchExists: false,
      branchWorktree: '/stale/path',
    }),
    {
      kind: 'repair',
      reason: '注册记录指向 clickvibe-issue-1 但路径不存在,需要清理注册后重建',
    },
  )
  assert.equal(
    buildWorktreeAddCommand({
      path: '/tmp/issue worktree',
      branch: 'clickvibe-issue-1',
      branchExists: false,
      remoteBase: 'origin/main',
    }),
    "git worktree add -b 'clickvibe-issue-1' '/tmp/issue worktree' 'origin/main'",
  )
})

test('privileged requests require loopback, exact origin and a custom request marker', () => {
  assert.equal(
    validatePrivilegedRequest({
      remoteAddress: '127.0.0.1',
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      requestMarker: '1',
    }),
    null,
  )
  assert.match(
    validatePrivilegedRequest({
      remoteAddress: '192.168.1.10',
      host: 'host:3080',
      origin: 'http://host:3080',
      requestMarker: '1',
    }) ?? '',
    /回环地址/,
  )
  assert.match(
    validatePrivilegedRequest({
      remoteAddress: '127.0.0.1',
      host: '127.0.0.1:3080',
      origin: 'https://evil.example',
      requestMarker: '1',
    }) ?? '',
    /跨站/,
  )
  assert.match(
    validatePrivilegedRequest({
      remoteAddress: '127.0.0.1',
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    }) ?? '',
    /授权请求头/,
  )
})

test('server authorization is one-use, bounded, expiring and bound to the frozen snapshot', () => {
  let now = 1000
  const store = new AuthorizationStore({ ttlMs: 100, limit: 2, now: () => now })
  const input = makeAuthorizationInput({
    action: 'develop',
    agent: 'codex',
    context: '',
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
  })
  const snapshot = {
    url: input.url,
    title: 'confirmed',
    body: 'safe',
    state: 'OPEN',
    updatedAt: '2026-08-21T00:00:00Z',
    comments: [],
  }
  const authorization = store.issue(input, snapshot)
  assert.equal(authorization.digest, authorizationDigest(input, snapshot))
  assert.equal(store.consume(authorization.id, { ...input, context: 'tampered' }, authorization.digest), null)
  assert.equal(
    store.consume(authorization.id, input, authorization.digest),
    null,
    'tampered attempt consumes capability',
  )

  const expiring = store.issue(input, snapshot)
  now += 101
  assert.equal(store.consume(expiring.id, input, expiring.digest), null)

  store.issue(input, snapshot)
  store.issue(input, snapshot)
  store.issue(input, snapshot)
  assert.equal(store.size, 2)
})

test('merge authorization input accepts only a well-formed manual override', () => {
  const base = {
    action: 'merge',
    url: 'https://github.com/ai-daming/clickvibe/issues/49',
    target: { prNumber: '29', branch: 'r-issue-49', head: 'abcdef1234567890', mergeFlag: '--merge' },
  }
  assert.deepEqual(
    makeAuthorizationInput({
      ...base,
      override: { skipped: ['review-hash', 'contract-changed', 'review-hash'], reason: ' 人工确认可合并 ' },
    }).override,
    { skipped: ['review-hash', 'contract-changed'], reason: '人工确认可合并' },
  )
  // 非对象(授权请求阶段的布尔开关)与其它 action 不产生 override 绑定
  assert.equal(makeAuthorizationInput({ ...base, override: true }).override, undefined)
  assert.equal(
    makeAuthorizationInput({
      action: 'review',
      agent: 'codex',
      url: 'https://github.com/ai-daming/clickvibe/issues/49',
      override: { skipped: ['review-hash'], reason: 'x' },
    }).override,
    undefined,
  )
  assert.throws(
    () =>
      makeAuthorizationInput({
        ...base,
        override: { skipped: ['github-protection'], reason: 'x' },
      }),
    /门禁项无效/,
  )
  assert.throws(
    () =>
      makeAuthorizationInput({
        ...base,
        override: { skipped: [], reason: 'x' },
      }),
    /门禁项无效/,
  )
  assert.throws(
    () =>
      makeAuthorizationInput({
        ...base,
        override: { skipped: ['review-hash'], reason: '   ' },
      }),
    /放行原因无效/,
  )
})

test('LineLog preserves a never-terminated long line and handles CRLF split across chunks', () => {
  const log = new LineLog(4)
  const longLine = `${'x'.repeat(70_000)} with /Users/example/project and /tmp/clickvibe`
  log.appendChunk(longLine.slice(0, 65_000))
  log.appendChunk(`${longLine.slice(65_000)}\r`)
  log.appendChunk('\nnext\r')
  log.appendChunk('\n')
  const read = log.read(0)
  assert.equal(read.lines.length, 2)
  assert.equal(read.lines[0], longLine)
  assert.equal(read.lines[1], 'next')
})

test('an unbounded raw LineLog preserves every event before parsing', () => {
  const log = new LineLog()
  for (let index = 0; index < 2001; index += 1) {
    log.appendChunk(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `m${index}` } })}\n`,
    )
  }

  const read = log.read(0)
  const parsed = parseAgentChunk('codex', read.lines.join('\n'))
  assert.equal(read.truncated, false)
  assert.equal(parsed.lines.length, 2001)
  assert.equal(parsed.lines[0].text, '💬 m0')
  assert.equal(parsed.lines[2000].text, '💬 m2000')
})

test('parseDependencies extracts Blocked by numbers from the 依赖 section', () => {
  assert.deepEqual(parseDependencies(`## 目标\n做 X\n\n## 依赖\n\nBlocked by #7`), [7])
  assert.deepEqual(parseDependencies(`## 依赖\n\nBlocked by #7, #8`), [7, 8])
  assert.deepEqual(parseDependencies(`## 依赖\n\n无`), [])
  assert.deepEqual(parseDependencies('## 目标\n无依赖,正常开发'), [])
  assert.deepEqual(parseDependencies(''), [])
  // 依赖章节后还有其它章节:不串台
  assert.deepEqual(parseDependencies(`## 依赖\n\nBlocked by #7\n\n## 验收标准\n- [ ] 通过 #7 的行为`), [7])
})
