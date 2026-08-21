import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthorizationStore,
  LineLog,
  authorizationDigest,
  buildWorktreeAddCommand,
  decideWorktreeRecovery,
  makeAuthorizationInput,
  parseAgent,
  parseGithubUrl,
  shellQuote,
  validatePrivilegedRequest,
} from '../src/develop.ts'

test('parseAgent accepts only the three supported agents', () => {
  assert.equal(parseAgent('codex'), 'codex')
  assert.equal(parseAgent('CLAUDE'), 'claude')
  assert.equal(parseAgent(' dryrun '), 'dryrun')
  assert.equal(parseAgent(undefined), 'codex')
  assert.throws(() => parseAgent('other'), /不支持的 agent/)
})

test('parseGithubUrl accepts exact issue and PR URLs only', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/ai-daming/clickvibe/issues/1'), {
    kind: 'issue', owner: 'ai-daming', repo: 'clickvibe', number: '1',
  })
  assert.equal(parseGithubUrl('https://github.com/a/b/issues/1/extra'), null)
  assert.equal(parseGithubUrl('https://evil.example/a/b/issues/1'), null)
})

test('shellQuote prevents POSIX shell expansion', () => {
  assert.equal(shellQuote('/tmp/simple'), "'/tmp/simple'")
  assert.equal(shellQuote("/tmp/a'b$(touch nope)"), "'/tmp/a'\\''b$(touch nope)'")
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
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: false, pathEmpty: false, registeredBranch: null,
    branchExists: false, branchWorktree: null,
  }), { kind: 'add-new-branch' })
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: true, registeredBranch: null,
    branchExists: true, branchWorktree: null,
  }), { kind: 'add-existing-branch' })
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: false, registeredBranch: 'clickvibe-issue-1',
    branchExists: true, branchWorktree: '/target',
  }), { kind: 'reuse' })
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: false, registeredBranch: 'HEAD',
    branchExists: false, branchWorktree: null,
  }), { kind: 'attach-detached' })
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: false, registeredBranch: 'HEAD',
    branchExists: true, branchWorktree: null,
  }), { kind: 'attach-existing' })
})

test('worktree recovery fails closed for conflicting partial states', () => {
  assert.match(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: false, registeredBranch: null,
    branchExists: false, branchWorktree: null,
  }).reason ?? '', /非空目录/)
  assert.match(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: true, pathEmpty: false, registeredBranch: 'other',
    branchExists: true, branchWorktree: null,
  }).reason ?? '', /其他分支/)
  assert.match(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: false, pathEmpty: false, registeredBranch: null,
    branchExists: true, branchWorktree: '/elsewhere',
  }).reason ?? '', /其他 worktree/)
})

test('stale registration with a missing branch is rebuilt from the explicit remote base', () => {
  assert.deepEqual(decideWorktreeRecovery({
    targetBranch: 'clickvibe-issue-1',
    pathExists: false, pathEmpty: false, registeredBranch: 'clickvibe-issue-1',
    branchExists: false, branchWorktree: '/stale/path',
  }), {
    kind: 'repair',
    reason: '注册记录指向 clickvibe-issue-1 但路径不存在,需要清理注册后重建',
  })
  assert.equal(buildWorktreeAddCommand({
    path: '/tmp/issue worktree',
    branch: 'clickvibe-issue-1',
    branchExists: false,
    remoteBase: 'origin/main',
  }), "git worktree add -b 'clickvibe-issue-1' '/tmp/issue worktree' 'origin/main'")
})

test('privileged requests require loopback, exact origin and a custom request marker', () => {
  assert.equal(validatePrivilegedRequest({
    remoteAddress: '127.0.0.1', host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080', requestMarker: '1',
  }), null)
  assert.match(validatePrivilegedRequest({
    remoteAddress: '192.168.1.10', host: 'host:3080', origin: 'http://host:3080', requestMarker: '1',
  }) ?? '', /回环地址/)
  assert.match(validatePrivilegedRequest({
    remoteAddress: '127.0.0.1', host: '127.0.0.1:3080',
    origin: 'https://evil.example', requestMarker: '1',
  }) ?? '', /跨站/)
  assert.match(validatePrivilegedRequest({
    remoteAddress: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080',
  }) ?? '', /授权请求头/)
})

test('server authorization is one-use, bounded, expiring and bound to the frozen snapshot', () => {
  let now = 1000
  const store = new AuthorizationStore({ ttlMs: 100, limit: 2, now: () => now })
  const input = makeAuthorizationInput({
    action: 'develop', agent: 'codex', context: '',
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
  })
  const snapshot = {
    url: input.url, title: 'confirmed', body: 'safe', state: 'OPEN', updatedAt: '2026-08-21T00:00:00Z', comments: [],
  }
  const authorization = store.issue(input, snapshot)
  assert.equal(authorization.digest, authorizationDigest(input, snapshot))
  assert.equal(store.consume(authorization.id, { ...input, context: 'tampered' }, authorization.digest), null)
  assert.equal(store.consume(authorization.id, input, authorization.digest), null, 'tampered attempt consumes capability')

  const expiring = store.issue(input, snapshot)
  now += 101
  assert.equal(store.consume(expiring.id, input, expiring.digest), null)

  store.issue(input, snapshot)
  store.issue(input, snapshot)
  store.issue(input, snapshot)
  assert.equal(store.size, 2)
})

test('LineLog bounds a never-terminated line and handles CRLF split across chunks', () => {
  const log = new LineLog(4)
  log.appendChunk('x'.repeat(LineLog.MAX_LINE_CHARS + 10))
  log.appendChunk('discarded\r')
  log.appendChunk('\nnext\r')
  log.appendChunk('\n')
  const read = log.read(0)
  assert.equal(read.lines.length, 2)
  assert.match(read.lines[0], /单行日志已截断/)
  assert.equal(read.lines[1], 'next')
})
