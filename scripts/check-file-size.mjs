import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const extensions = new Set(['.ts', '.tsx'])

async function collect(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(relative)))
    else if (extensions.has(path.extname(entry.name))) files.push(relative)
  }
  return files
}

const exceptions = JSON.parse(await readFile(path.join(root, 'scripts/file-size-exceptions.json'), 'utf8'))
const exceptionByPath = new Map(exceptions.map((entry) => [entry.path, entry]))
const failures = []

for (const file of [...(await collect('src')), ...(await collect('tests'))].sort()) {
  const contents = await readFile(path.join(root, file), 'utf8')
  const lines = contents === '' ? 0 : contents.split(/\r?\n/).length
  const exception = exceptionByPath.get(file)
  if (lines > 800 && !(exception?.over800Legacy === true)) {
    failures.push(`${file}: ${lines} lines (>800, split required)`)
  } else if (lines > 800 && exception?.over800Legacy === true) {
    console.warn(`${file}: ${lines} lines (>800 legacy debt, tracked split in ${exception.issueRef})`)
  } else if (lines > 500 && !exception) failures.push(`${file}: ${lines} lines (>500, explanation required)`)
  else if (exception && lines <= 500) failures.push(`${file}: stale exception (${lines} lines)`)
}

for (const exception of exceptions) {
  if (!exception.reason || !exception.issueRef) failures.push(`${exception.path}: exception needs reason and issueRef`)
}

if (failures.length > 0) {
  console.error(`File-size gate failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`File-size gate passed (${exceptions.length} explained exception${exceptions.length === 1 ? '' : 's'}).`)
}
