/** ADR-0017's fixed active root; never falls back to the old runtime's directory. */
import { homedir } from 'node:os'
import { join } from 'node:path'
export function recoveryStateRoot(home = homedir()): string {
  return join(home, '.clickvibe', 'state-recovery-1')
}
export function recoveryJournalPath(home = homedir()): string {
  return join(home, '.clickvibe', 'upgrade-recovery-1.json')
}
export const RECOVERY_GENERATION = 'v0.2-recovery-1'
