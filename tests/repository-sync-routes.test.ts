import assert from 'node:assert/strict'
import { beforeEach } from 'node:test'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'

beforeEach(() => resetGithubGatewayOwnerForTests())
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/index.ts'
import { repositoryFreshness } from '../src/infra/runtime.ts'

interface Scenario {
  branch: string | null
  dirty?: boolean
  main?: { behind: number; ahead: number } | null
  checkout?: { behind: number; ahead: number } | null
  conflict?: boolean
}

interface ShellResult {
  exitCode: number
  stdout: { text: string }
  stderr: { text: string }
}

const shellResult = (text = '', exitCode = 0): ShellResult => ({
  exitCode,
  stdout: { text },
  stderr: { text: exitCode === 0 ? '' : text },
})

function fakeShell(scenario: Scenario, commands: string[]) {
  return async (spec: { command: string }): Promise<ShellResult> => {
    const command = spec.command
    commands.push(command)
    if (command.startsWith('set +e') && command.includes('REPO_MAIN_COUNT')) {
      const enc = (value: string) => Buffer.from(value, 'utf8').toString('base64')
      const line = (key: string, rc: number, value: string) => `${key}\t${rc}\t${enc(value)}`
      return shellResult(
        [
          line('REPO_DEFAULT', 0, 'origin/main'),
          line('REPO_BRANCH', 0, scenario.branch ?? ''),
          line('REPO_HEAD', 0, 'abc1234'),
          scenario.main
            ? line('REPO_MAIN_COUNT', 0, `${scenario.main.behind} ${scenario.main.ahead}`)
            : line('REPO_MAIN_COUNT', 1, ''),
          scenario.checkout
            ? line('REPO_HEAD_COUNT', 0, `${scenario.checkout.behind} ${scenario.checkout.ahead}`)
            : line('REPO_HEAD_COUNT', 1, ''),
        ].join('\n'),
      )
    }
    if (command === 'git fetch origin --prune') return shellResult()
    if (command.startsWith('git for-each-ref')) return shellResult()
    if (command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') return shellResult('origin/main')
    if (command === 'git branch --show-current') return shellResult(scenario.branch ?? '')
    if (command === 'git status --porcelain') return shellResult(scenario.dirty ? ' M local.txt' : '')
    if (command.includes('git rev-list --left-right --count') && /\.\.\.'?main'?$/.test(command)) {
      return scenario.main ? shellResult(`${scenario.main.behind} ${scenario.main.ahead}`) : shellResult('missing', 1)
    }
    if (command.includes('git rev-list --left-right --count') && /\.\.\.'?HEAD'?$/.test(command)) {
      return scenario.checkout
        ? shellResult(`${scenario.checkout.behind} ${scenario.checkout.ahead}`)
        : shellResult('missing', 1)
    }
    if (/^git merge --ff-only '?origin\/main'?$/.test(command)) return shellResult('fast-forwarded')
    if (/^git merge --no-edit '?origin\/main'?$/.test(command)) {
      return scenario.conflict ? shellResult('CONFLICT', 1) : shellResult('merged')
    }
    if (/^git branch -f main '?origin\/main'?$/.test(command)) return shellResult('branch main updated')
    if (/^git rev-parse --short '?HEAD'?$/.test(command)) return shellResult('abc1234')
    if (/^git rev-parse --short '?MERGE_HEAD'?$/.test(command)) {
      return scenario.conflict ? shellResult('def5678') : shellResult('missing', 1)
    }
    if (command === 'git diff --name-only --diff-filter=U') return shellResult('src/a.ts\nREADME.md')
    throw new Error(`unexpected shell command: ${command}`)
  }
}

function createHandler(run: (spec: { command: string; workdir?: string }) => Promise<unknown>): RequestListener {
  let handler: RequestListener | null = null
  apply({
    skills: { register: () => () => {} },
    webServer: {
      register(route: { handler: RequestListener }) {
        handler = route.handler
        return () => {}
      },
    },
    // cordis fiber lifecycle api; the gateway close effect is never torn down
    // by this unit harness.
    effect: () => () => {},
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      run,
      start() {
        throw new Error('shell start is not used')
      },
    },
  } as never)
  assert.ok(handler)
  return handler
}

async function post(listener: RequestListener, method: 'state' | 'sync', body: unknown) {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: `/clickvibe/api/${method}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            origin: `http://127.0.0.1:${address.port}`,
            'x-clickvibe-request': '1',
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function withConfiguredRepo(
  scenario: Scenario,
  run: (handler: RequestListener, commands: string[]) => Promise<void>,
) {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-repo-sync-'))
  const repo = join(home, 'repo')
  const commands: string[] = []
  process.env.HOME = home
  repositoryFreshness.clear()
  try {
    await initFixtureRepository(repo)
    await activateV02Home(home, { 'o/r': repo })
    await run(createHandler(fakeShell(scenario, commands)), commands)
  } finally {
    repositoryFreshness.clear()
    process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

test('/state reports repository default and checkout lag after the shared fetch gate', async () => {
  await withConfiguredRepo(
    { branch: 'feature/x', main: { behind: 4, ahead: 0 }, checkout: { behind: 2, ahead: 1 } },
    async (handler) => {
      const result = await post(handler, 'state', { repoKey: 'o/r' })
      assert.equal(result.status, 200)
      assert.deepEqual(result.body.repoAdvance, {
        defaultBranch: 'main',
        remoteRef: 'origin/main',
        mainBehind: 4,
        checkoutBranch: 'feature/x',
        checkoutBehind: 2,
        fetchedAt: (result.body.freshness as { lastSuccessAt: number }).lastSuccessAt,
      })
    },
  )
})

test('/sync repoKey fast-forwards checkout and local main independently', async () => {
  await withConfiguredRepo(
    { branch: 'feature/x', main: { behind: 3, ahead: 0 }, checkout: { behind: 2, ahead: 0 } },
    async (handler, commands) => {
      const result = await post(handler, 'sync', { repoKey: 'o/r' })
      assert.equal(result.status, 200)
      assert.equal(result.body.mainRefForwarded, true)
      assert.deepEqual(result.body.branchHead, { branch: 'feature/x', head: 'abc1234' })
      assert.ok(commands.some((command) => command.includes('git merge --ff-only')))
      assert.ok(commands.some((command) => command.includes('git branch -f main')))
    },
  )
})

test('/sync dirty checkout refuses it but still forwards unowned local main', async () => {
  await withConfiguredRepo(
    { branch: 'feature/x', dirty: true, main: { behind: 3, ahead: 0 }, checkout: { behind: 2, ahead: 0 } },
    async (handler, commands) => {
      const result = await post(handler, 'sync', { repoKey: 'o/r' })
      assert.equal(result.status, 200)
      assert.match(String((result.body.refused as string[])[0]), /未提交改动/)
      assert.equal(result.body.mainRefForwarded, true)
      assert.equal(
        commands.some((command) => command.startsWith('git merge ')),
        false,
      )
      assert.ok(commands.some((command) => command.includes('git branch -f main')))
    },
  )
})

test('/sync detached checkout refuses it but still reports the main target', async () => {
  await withConfiguredRepo({ branch: null, main: { behind: 0, ahead: 0 }, checkout: null }, async (handler) => {
    const result = await post(handler, 'sync', { repoKey: 'o/r' })
    assert.equal(result.status, 200)
    assert.match(String((result.body.refused as string[])[0]), /不在任何分支/)
    assert.equal((result.body.targets as { main: { status: string } }).main.status, 'unchanged')
  })
})

test('/sync creates a real merge for a clean diverged checkout', async () => {
  await withConfiguredRepo(
    { branch: 'feature/x', main: { behind: 0, ahead: 0 }, checkout: { behind: 2, ahead: 1 } },
    async (handler, commands) => {
      const result = await post(handler, 'sync', { repoKey: 'o/r' })
      assert.equal(result.status, 200)
      assert.deepEqual(result.body.branchHead, { branch: 'feature/x', head: 'abc1234' })
      assert.ok(commands.some((command) => command.includes('git merge --no-edit')))
      assert.equal((result.body.targets as { checkout: { status: string } }).checkout.status, 'merged')
    },
  )
})

test('/sync preserves a diverged merge conflict and returns files plus agent guidance', async () => {
  await withConfiguredRepo(
    { branch: 'feature/x', main: { behind: 0, ahead: 0 }, checkout: { behind: 2, ahead: 1 }, conflict: true },
    async (handler) => {
      const result = await post(handler, 'sync', { repoKey: 'o/r' })
      assert.equal(result.status, 200)
      assert.deepEqual(result.body.conflict, { files: ['src/a.ts', 'README.md'] })
      assert.match(JSON.stringify(result.body), /先同步最新代码并解决冲突/)
      assert.equal((result.body.targets as { checkout: { status: string } }).checkout.status, 'conflict')
    },
  )
})
