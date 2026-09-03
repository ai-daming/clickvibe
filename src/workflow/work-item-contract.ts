/** Pure canonicalization for ADR-0012 Work Item contract v1. */
import { createHash } from 'node:crypto'
import type {
  AcceptanceCriterion,
  ContractField,
  ContractUnknownReason,
  VerificationAuthority,
  WorkItemContractSnapshot,
  WorkItemIdentity,
} from '../infra/contracts.ts'
import { parseWorkItemIdentity } from '../infra/work-item-identity.ts'

type CanonicalContract = Omit<WorkItemContractSnapshot, 'fingerprint'> & {
  fingerprint?: WorkItemContractSnapshot['fingerprint']
}

const AUTHORITY_ORDER: Record<VerificationAuthority, number> = { agent: 0, human: 1, external: 2 }
const UNKNOWN_REASONS = new Set<ContractUnknownReason>(['missing', 'conflicting', 'unparseable'])

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('contract text must contain only Unicode scalar values')
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('contract text must contain only Unicode scalar values')
    }
  }
}

export function normalizeContractText(value: string): string {
  if (typeof value !== 'string') throw new Error('contract text must be a string')
  assertUnicodeScalars(value)
  const lines = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function identityTuple(value: WorkItemIdentity): [string, number, string, string, string, string] {
  const identity = parseWorkItemIdentity(value)
  for (const field of Object.values(identity)) assertUnicodeScalars(field)
  return ['clickvibe.work-item-identity', 1, identity.provider, identity.instance, identity.container, identity.id]
}

function unknownTuple<T>(field: Extract<ContractField<T>, { state: 'unknown' }>): ['unknown', ContractUnknownReason] {
  if (!UNKNOWN_REASONS.has(field.reason)) throw new Error(`unknown contract reason: ${String(field.reason)}`)
  return ['unknown', field.reason]
}

function scalarTuple(field: ContractField<string>): ['known', string] | ['unknown', ContractUnknownReason] {
  if (field.state === 'unknown') return unknownTuple(field)
  const normalized = normalizeContractText(field.value)
  if (normalized === '') throw new Error('required contract text must not normalize to empty')
  return ['known', normalized]
}

function stringListTuple(field: ContractField<string[]>): ['known', string[]] | ['unknown', ContractUnknownReason] {
  if (field.state === 'unknown') return unknownTuple(field)
  const values = field.value.map(normalizeContractText)
  if (values.some((value) => value === '')) throw new Error('contract list item must not normalize to empty')
  values.sort(utf8Compare)
  if (new Set(values).size !== values.length) throw new Error('contract list contains normalized duplicates')
  return ['known', values]
}

function acceptanceTuple(
  field: ContractField<AcceptanceCriterion[]>,
): ['known', Array<[VerificationAuthority, string]>] | ['unknown', ContractUnknownReason] {
  if (field.state === 'unknown') return unknownTuple(field)
  const values: Array<[VerificationAuthority, string]> = field.value.map((criterion) => {
    if (!(criterion.verificationAuthority in AUTHORITY_ORDER)) throw new Error('unknown verification authority')
    const description = normalizeContractText(criterion.description)
    if (description === '') throw new Error('acceptance criterion must not normalize to empty')
    return [criterion.verificationAuthority, description]
  })
  values.sort((left, right) => AUTHORITY_ORDER[left[0]] - AUTHORITY_ORDER[right[0]] || utf8Compare(left[1], right[1]))
  const keys = values.map(([authority, description]) => `${authority}\u0000${description}`)
  if (new Set(keys).size !== keys.length) throw new Error('acceptance criteria contain normalized duplicates')
  return ['known', values]
}

function dependencyTuple(
  field: ContractField<WorkItemIdentity[]>,
): ['known', ReturnType<typeof identityTuple>[]] | ['unknown', ContractUnknownReason] {
  if (field.state === 'unknown') return unknownTuple(field)
  const values = field.value.map(identityTuple)
  values.sort((left, right) => utf8Compare(JSON.stringify(left), JSON.stringify(right)))
  const keys = values.map((value) => JSON.stringify(value))
  if (new Set(keys).size !== keys.length) throw new Error('contract dependencies contain duplicates')
  return ['known', values]
}

export function canonicalWorkItemContractBytes(contract: CanonicalContract): Buffer {
  if (contract.schemaVersion !== 1 || contract.canonicalizationVersion !== 1) {
    throw new Error('unknown WorkItem contract version')
  }
  const tuple = [
    'clickvibe.work-item-contract',
    1,
    identityTuple(contract.workItem),
    ['goal', scalarTuple(contract.goal)],
    ['acceptanceCriteria', acceptanceTuple(contract.acceptanceCriteria)],
    ['dependencies', dependencyTuple(contract.dependencies)],
    ['nonGoals', stringListTuple(contract.nonGoals)],
    ['constraints', stringListTuple(contract.constraints)],
  ]
  return Buffer.from(JSON.stringify(tuple), 'utf8')
}

export function fingerprintWorkItemContract(contract: CanonicalContract): `wic1_${string}` {
  const digest = createHash('sha256').update(canonicalWorkItemContractBytes(contract)).digest('base64url')
  return `wic1_${digest}`
}
