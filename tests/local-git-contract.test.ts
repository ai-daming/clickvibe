/**
 * Contract-driven negative harness (issue #122, fix-discipline): one harness
 * consumes ALL section contract tables — worktree, repository and
 * enumeration — mutating a canonical healthy sample per section (missing /
 * rc=128 / garbage) and asserting the parser classifies each variant exactly
 * as the contract declares.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseRepositoryEnumeration,
  parseRepositorySample,
  parseWorktreeSample,
  REPOSITORY_ENUMERATION_SECTION_CONTRACT,
  REPOSITORY_SECTION_CONTRACT,
  WORKTREE_SECTION_CONTRACT,
} from '../src/infra/local-git-sampler.ts'
import type { SectionContract } from '../src/infra/local-git-sampler.ts'

function section(key: string, rc: number, value: string | null): string {
  const encoded = value === null ? '' : Buffer.from(value, 'utf8').toString('base64')
  return `${key}\t${rc}\t${encoded}`
}

type Canonical = Array<[string, number, string]>

function buildRows(rows: Canonical): string {
  return rows.map(([key, rc, value]) => section(key, rc, value)).join('\n')
}

function assertVariants(
  entry: SectionContract,
  canonical: Canonical,
  parse: (output: string) => { requiredFailures: Array<{ operation: string }> },
  verbFor: (contract: SectionContract) => string,
) {
  const index = canonical.findIndex(([key]) => key === entry.section)
  assert.ok(index >= 0, `${entry.section} must appear in the canonical sample`)
  const variants: Array<{ name: string; make: () => string; expect: 'fail' | 'ok' | 'skip' }> = [
    {
      name: 'missing',
      make: () => buildRows(canonical.filter((_, i) => i !== index)),
      expect: entry.negative.missing,
    },
    {
      name: 'rc-failure',
      make: () =>
        buildRows(
          canonical.map((row, i) =>
            i === index ? ([row[0], 128, `fatal: ${row[0]} broke`] as [string, number, string]) : row,
          ),
        ),
      expect: entry.negative.rcNonZero,
    },
    {
      name: 'garbage-value',
      make: () =>
        buildRows(
          canonical.map((row, i) => (i === index ? ([row[0], 0, 'garbage value'] as [string, number, string]) : row)),
        ),
      expect: entry.negative.garbage,
    },
  ]
  for (const variant of variants) {
    if (variant.expect === 'skip') continue
    const parsed = parse(variant.make())
    const verb = verbFor(entry)
    const flagged = parsed.requiredFailures.some(
      (failure) => failure.operation.includes(entry.section) || failure.operation.includes(verb),
    )
    assert.equal(
      flagged,
      variant.expect === 'fail',
      `${entry.section} ${variant.name}: expected ${variant.expect}, operations=${JSON.stringify(parsed.requiredFailures.map((failure) => failure.operation))}`,
    )
  }
}

const WORKTREE_VERB = (entry: SectionContract): string => {
  if (entry.section.startsWith('EB_') || entry.section === 'WT_BASE_REF' || entry.section === 'BR_BASE_REF') {
    return `effective-base ${entry.section}`
  }
  const verb = entry.producer.match(
    /rev-parse --git-dir|rev-parse --short|rev-list --left-right|rev-list --count|show-ref|symbolic-ref|branch --show-current|status --porcelain|rev-parse/,
  )
  return verb ? verb[0].split(' ')[0] : entry.producer
}

const REPOSITORY_VERB = (entry: SectionContract): string => {
  const verb = entry.producer.match(/rev-parse|rev-list|symbolic-ref|branch --show-current|for-each-ref/)
  return verb ? verb[0].split(' ')[0] : entry.producer
}

test('contract-driven negatives: every section reacts to missing/rc/garbage as classified', () => {
  // Canonical healthy sample: worktree fully observable, base resolved via a
  // named ref, upstream present, branch facts present.
  const canonical: Array<[string, number, string]> = [
    ['WT_GITDIR', 0, '/wt/.git'],
    ['EB_NAMED', 0, 'origin/main'],
    ['EB_COMPARE', 0, 'origin/main'],
    ['EB_SOURCE', 0, 'named-ref'],
    ['EB_AVAILABLE', 0, '1'],
    ['WT_BASE_REF', 0, 'origin/main'],
    ['WT_HEAD', 0, 'abc1234'],
    ['WT_BRANCH', 0, 'feature'],
    ['WT_STATUS', 0, ''],
    ['WT_MAIN', 0, 'aaa0000'],
    ['WT_MAIN_COUNT', 0, '0 1'],
    ['WT_BASE', 0, 'bbb0000'],
    ['WT_BASE_COUNT', 0, '0 2'],
    ['WT_UPSTREAM', 0, 'abc1234'],
    ['WT_UP_COUNT', 0, '0 0'],
    ['WT_MERGE_HEAD', 1, ''],
    ['BR_GITDIR', 0, '/repo/.git'],
    ['BR_DEFAULT', 0, 'origin/main'],
    ['BR_REF_ERROR', 0, ''],
    ['BR_REF', 0, 'feature'],
    ['BR_BASE_REF', 0, 'origin/main'],
    ['BR_COMMIT_COUNT', 0, '2'],
  ]
  const build = (rows: Array<[string, number, string]>) =>
    rows.map(([key, rc, value]) => section(key, rc, value)).join('\n')
  const baseline = parseWorktreeSample(build(canonical))
  assert.deepEqual(baseline.requiredFailures, [], 'canonical sample must be failure-free')

  const verbFor = (entry: { section: string; producer: string }): string => {
    if (entry.section.startsWith('EB_') || entry.section === 'WT_BASE_REF' || entry.section === 'BR_BASE_REF') {
      return `effective-base ${entry.section}`
    }
    const verb = entry.producer.match(
      /rev-parse --git-dir|rev-parse --short|rev-list --left-right|rev-list --count|show-ref|symbolic-ref|branch --show-current|status --porcelain|rev-parse/,
    )
    return verb ? verb[0].split(' ')[0] : entry.producer
  }

  for (const entry of WORKTREE_SECTION_CONTRACT) {
    const index = canonical.findIndex(([key]) => key === entry.section)
    if (index < 0) continue // conditional sections absent from this canonical sample

    const variants: Array<{ name: string; make: () => string; expect: 'fail' | 'ok' | 'skip' }> = [
      {
        name: 'missing',
        make: () => build(canonical.filter((_, i) => i !== index)),
        expect: entry.negative.missing,
      },
      {
        name: 'rc-failure',
        make: () => {
          const rows = canonical.map((row, i) =>
            i === index ? ([row[0], 128, `fatal: ${row[0]} broke`] as [string, number, string]) : row,
          )
          return build(rows)
        },
        expect: entry.negative.rcNonZero,
      },
      {
        name: 'garbage-value',
        make: () => {
          const rows = canonical.map((row, i) =>
            i === index ? ([row[0], 0, 'garbage value'] as [string, number, string]) : row,
          )
          return build(rows)
        },
        expect: entry.negative.garbage,
      },
    ]
    for (const variant of variants) {
      if (variant.expect === 'skip') continue
      const parsed = parseWorktreeSample(variant.make())
      const verb = verbFor(entry)
      const flagged = parsed.requiredFailures.some(
        (failure) => failure.operation.includes(entry.section) || failure.operation.includes(verb),
      )
      assert.equal(
        flagged,
        variant.expect === 'fail',
        `${entry.section} ${variant.name}: expected ${variant.expect}, operations=${JSON.stringify(parsed.requiredFailures.map((f) => f.operation))}`,
      )
    }
  }
})

test('contract-driven negatives: repository sections and strict numeric shapes', () => {
  const canonicalRepo: Array<[string, number, string]> = [
    ['REPO_DEFAULT', 0, 'origin/main'],
    ['REPO_BRANCH', 0, 'main'],
    ['REPO_HEAD', 0, 'abc1234'],
    ['REPO_MAIN_COUNT', 0, '0 1'],
    ['REPO_HEAD_COUNT', 0, '0 1'],
  ]
  const buildRepo = (rows: Array<[string, number, string]>) =>
    rows.map(([key, rc, value]) => section(key, rc, value)).join('\n')
  assert.deepEqual(parseRepositorySample(buildRepo(canonicalRepo)).requiredFailures, [])

  const verbFor = (entry: { section: string; producer: string }): string => {
    const verb = entry.producer.match(/rev-parse|rev-list|symbolic-ref|branch --show-current/)
    return verb ? verb[0].split(' ')[0] : entry.producer
  }
  for (const entry of REPOSITORY_SECTION_CONTRACT) {
    const index = canonicalRepo.findIndex(([key]) => key === entry.section)
    assert.ok(index >= 0, `${entry.section} must appear in the canonical repository sample`)
    const variants: Array<{ name: string; make: () => string; expect: 'fail' | 'ok' | 'skip' }> = [
      {
        name: 'missing',
        make: () => buildRepo(canonicalRepo.filter((_, i) => i !== index)),
        expect: entry.negative.missing,
      },
      {
        name: 'rc-failure',
        make: () =>
          buildRepo(
            canonicalRepo.map((row, i) =>
              i === index ? ([row[0], 128, 'fatal: broke'] as [string, number, string]) : row,
            ),
          ),
        expect: entry.negative.rcNonZero,
      },
      {
        name: 'garbage-value',
        make: () =>
          buildRepo(
            canonicalRepo.map((row, i) =>
              i === index ? ([row[0], 0, 'garbage value'] as [string, number, string]) : row,
            ),
          ),
        expect: entry.negative.garbage,
      },
    ]
    for (const variant of variants) {
      if (variant.expect === 'skip') continue
      const parsed = parseRepositorySample(variant.make())
      const verb = verbFor(entry)
      const flagged = parsed.requiredFailures.some(
        (failure) => failure.operation.includes(entry.section) || failure.operation.includes(verb),
      )
      assert.equal(
        flagged,
        variant.expect === 'fail',
        `${entry.section} ${variant.name}: expected ${variant.expect}, operations=${JSON.stringify(parsed.requiredFailures.map((f) => f.operation))}`,
      )
    }
  }

  const fractional = canonicalRepo.map((row) =>
    row[0] === 'REPO_MAIN_COUNT' ? (['REPO_MAIN_COUNT', 0, '1.5 2'] as [string, number, string]) : row,
  )
  assert.ok(
    parseRepositorySample(buildRepo(fractional)).requiredFailures.length > 0,
    'a fractional compare value must fail',
  )

  const worktreeCanonical: Array<[string, number, string]> = [
    ['WT_GITDIR', 0, '/wt/.git'],
    ['EB_NAMED', 0, 'origin/main'],
    ['EB_COMPARE', 0, 'origin/main'],
    ['EB_SOURCE', 0, 'named-ref'],
    ['EB_AVAILABLE', 0, '1'],
    ['WT_BASE_REF', 0, 'origin/main'],
    ['WT_HEAD', 0, 'abc1234'],
    ['WT_BRANCH', 0, 'feature'],
    ['WT_STATUS', 0, ''],
    ['WT_MAIN', 1, ''],
    ['WT_MAIN_COUNT', 1, ''],
    ['WT_BASE', 0, 'bbb0000'],
    ['WT_BASE_COUNT', 0, '1.5 2'],
    ['WT_UPSTREAM', 127, ''],
    ['WT_UP_COUNT', 127, ''],
    ['WT_MERGE_HEAD', 1, ''],
    ['BR_GITDIR', 0, '/repo/.git'],
    ['BR_DEFAULT', 0, 'origin/main'],
    ['BR_REF_ERROR', 0, ''],
    ['BR_REF', 0, 'feature'],
    ['BR_BASE_REF', 0, 'origin/main'],
    ['BR_COMMIT_COUNT', 0, '1.5'],
  ]
  const parsed = parseWorktreeSample(worktreeCanonical.map(([key, rc, value]) => section(key, rc, value)).join('\n'))
  assert.ok(
    parsed.requiredFailures.some((failure) => failure.operation.includes('origin/main...HEAD')),
    'a fractional base compare must fail',
  )
  assert.ok(
    parsed.requiredFailures.some((failure) => failure.operation.includes('origin/main..feature')),
    'a fractional commit count must fail, never hasCommits:true',
  )
  assert.equal(parsed.branchFacts.hasCommits, undefined)
})

test('contract-driven negatives: enumeration sections execute the same harness', () => {
  const canonical: Canonical = [
    ['ENUM_GITDIR', 0, '/repo/.git'],
    ['ENUM_HEAD', 0, 'abc1234'],
    ['ENUM_DEFAULT', 0, 'origin/main'],
    ['ENUM_REFS', 0, 'main\nclickvibe-issue-122'],
    ['ENUM_BASE_AVAILABLE', 0, '1'],
    ['ENUM_COUNTS', 0, 'main\t0\t0\nclickvibe-issue-122\t0\t2'],
  ]
  assert.deepEqual(parseRepositoryEnumeration(buildRows(canonical)).requiredFailures, [])
  for (const entry of REPOSITORY_ENUMERATION_SECTION_CONTRACT) {
    assertVariants(entry, canonical, parseRepositoryEnumeration, REPOSITORY_VERB)
  }

  // Review round 6 regressions: removing availability, removing the counts
  // section, or failing its outer rc must all be required failures — never a
  // silent empty parse.
  const noAvail = canonical.filter(([key]) => key !== 'ENUM_BASE_AVAILABLE')
  assert.ok(
    parseRepositoryEnumeration(buildRows(noAvail)).requiredFailures.length > 0,
    'missing availability must fail',
  )

  const noCounts = canonical.filter(([key]) => key !== 'ENUM_COUNTS')
  assert.ok(parseRepositoryEnumeration(buildRows(noCounts)).requiredFailures.length > 0, 'missing counts must fail')

  const outerRc = canonical.map((row) =>
    row[0] === 'ENUM_COUNTS' ? (['ENUM_COUNTS', 128, 'fatal: loop broke'] as [string, number, string]) : row,
  )
  assert.ok(parseRepositoryEnumeration(buildRows(outerRc)).requiredFailures.length > 0, 'outer counts rc must fail')
})
