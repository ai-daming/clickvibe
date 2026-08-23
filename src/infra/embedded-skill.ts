import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'

interface SkillFrontmatter {
  name?: unknown
  description?: unknown
}

export interface EmbeddedSkill {
  name: string
  description: string
  source: 'clickvibe'
  content: string
}

function skillDocumentUrl(): URL {
  const packaged = new URL('../skills/gh-issue/SKILL.md', import.meta.url)
  return existsSync(packaged) ? packaged : new URL('../../skills/gh-issue/SKILL.md', import.meta.url)
}

export function loadEmbeddedGhIssueSkill(): EmbeddedSkill {
  const document = readFileSync(skillDocumentUrl(), 'utf8')
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match === null) throw new Error('embedded gh-issue skill is missing YAML frontmatter')

  const metadata = parse(match[1]) as SkillFrontmatter
  if (metadata.name !== 'gh-issue' || typeof metadata.description !== 'string' || metadata.description === '') {
    throw new Error('embedded gh-issue skill has invalid metadata')
  }
  return {
    name: metadata.name,
    description: metadata.description,
    source: 'clickvibe',
    content: match[2].trim(),
  }
}
