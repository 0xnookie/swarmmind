/**
 * Pure helpers for Canvas mode's task cards — the visual-orchestrator layer that
 * maps board gestures onto the real tasks table (`CanvasMode.tsx` is the impure
 * shell that calls `taskEdit`/`taskList`). The `depends_on` column is a
 * comma-separated id string (see `memory/queries.ts`); adding/removing a
 * dependency by dragging a connector is exactly the kind of string surgery
 * that's easy to get subtly wrong (dupes, empty segments, self-deps), so it
 * lives here and is unit-tested.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'

/** Parse the comma-separated `depends_on` column into a clean id list. */
export function parseDeps(depends_on: string | null | undefined): string[] {
  return depends_on ? depends_on.split(',').map(s => s.trim()).filter(Boolean) : []
}

/** Serialize an id list back to the column form (empty list → null). */
export function serializeDeps(ids: string[]): string | null {
  const clean = ids.map(s => s.trim()).filter(Boolean)
  return clean.length ? clean.join(',') : null
}

/**
 * Add `depId` as a prerequisite of a task with the given current `depends_on`,
 * returning the new column value. No-ops (returns the same set) when the dep is
 * already present or would make the task depend on itself.
 */
export function addDep(depends_on: string | null | undefined, depId: string, selfId: string): string | null {
  const deps = parseDeps(depends_on)
  if (!depId || depId === selfId || deps.includes(depId)) return serializeDeps(deps)
  return serializeDeps([...deps, depId])
}

/** Remove `depId` from a task's `depends_on`, returning the new column value. */
export function removeDep(depends_on: string | null | undefined, depId: string): string | null {
  return serializeDeps(parseDeps(depends_on).filter(id => id !== depId))
}

/** Would adding `depId` to `taskId` create a dependency cycle? `depsOf` maps a
 *  task id to its direct prerequisites. Walks the prerequisite graph from
 *  `depId` looking for `taskId` — if found, the new edge closes a loop. */
export function wouldCycle(
  taskId: string,
  depId: string,
  depsOf: (id: string) => string[]
): boolean {
  if (taskId === depId) return true
  const seen = new Set<string>()
  const stack = [depId]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === taskId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const d of depsOf(cur)) stack.push(d)
  }
  return false
}

/** Brand-consistent colour for a task status — the card border and badge. */
export function taskStatusColor(status: TaskStatus | string): string {
  switch (status) {
    case 'in_progress': return 'var(--accent)'
    case 'needs_review': return '#c89be0'
    case 'done': return '#7fc8a0'
    case 'failed': return '#e5484d'
    case 'pending':
    default: return 'var(--text-muted)'
  }
}
