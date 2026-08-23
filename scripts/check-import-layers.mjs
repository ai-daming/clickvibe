import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const layer = { infra: 0, github: 1, agent: 2, workflow: 3 }

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
  const sourceDomain = file.split('/')[1]
  const sourceLayer = layer[sourceDomain]
  const contents = await readFile(path.join(root, file), 'utf8')
  for (const match of contents.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (file.startsWith('src/client/') && specifier.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      if (resolved.startsWith('src/') && !resolved.startsWith('src/client/')) {
        failures.push(`${file}: client may not import host module ${specifier}`)
        continue
      }
    }
    if (sourceLayer === undefined || !specifier.startsWith('.')) continue
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).split('/')[1]
    const targetLayer = layer[target]
    if (targetLayer !== undefined && targetLayer > sourceLayer) {
      failures.push(`${file}: layer ${sourceLayer} may not import ${target} layer ${targetLayer}`)
    }
  }
}

if (failures.length > 0) {
  console.error(`Import-layer gate failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Import-layer gate passed.')
}
