/** Config/DSH union selector and the one-click import control. */
import type { ProjectOption } from '../domain.ts'

export function ProjectSelector({
  projects,
  selected,
  importBusy,
  onSelect,
  onImport,
}: {
  projects: ProjectOption[]
  selected: ProjectOption | null
  importBusy: boolean
  onSelect(project: ProjectOption): void
  onImport(project: ProjectOption): void
}) {
  return (
    <>
      <select
        className="cv-select"
        value={selected?.repoKey ?? ''}
        onChange={(event) => {
          const project = projects.find((candidate) => candidate.repoKey === event.target.value)
          if (project) onSelect(project)
        }}
      >
        {projects.map((project) => (
          <option key={project.repoKey} value={project.repoKey}>
            {project.configured === false ? project.path.split(/[\\/]/).pop() || project.path : project.repoKey}
            {project.configured === false ? ' · 未配置' : project.available ? '' : ' · 远程配置'}
          </option>
        ))}
      </select>
      {selected?.configured === false ? (
        <div className="cv-project-import">
          <span title={selected.path}>{selected.path}</span>
          <button className="cv-batch-btn" disabled={importBusy} onClick={() => onImport(selected)}>
            {importBusy ? '导入中…' : '导入'}
          </button>
        </div>
      ) : null}
    </>
  )
}
