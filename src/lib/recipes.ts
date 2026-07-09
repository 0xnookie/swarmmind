// Swarm recipes: one-click multi-agent templates ("1 lead + 2 workers + 1
// reviewer") that pre-wire the pane layout, titles, worktree isolation, the lead
// pane and the orchestration mode — so the orchestration power is reachable in
// one click instead of manual pane surgery. Pure and dependency-free (the id
// generator is injected) so the layout builder is unit-testable; the impure
// apply step (store, confirm dialog) lives in OrchestratorBar.tsx.

export type RecipeRole = 'lead' | 'worker' | 'reviewer'

export interface RecipePane {
  role: RecipeRole
  /** Pane title shown in the UI and used for worktree branch names. */
  title: string
  /** Isolate this pane's agent on its own git worktree/branch. */
  worktree?: boolean
}

export interface SwarmRecipe {
  /** Stable id — the UI derives i18n keys from it (recipes.<id>.name/.desc). */
  id: string
  emoji: string
  panes: RecipePane[]
  mode: 'auto' | 'assisted'
}

// The catalog. Workers get worktree isolation (their edits stay mergeable and
// conflict-free); the lead and reviewers work read-mostly and stay on the root.
export const SWARM_RECIPES: SwarmRecipe[] = [
  {
    id: 'pair',
    emoji: '🤝',
    mode: 'auto',
    panes: [
      { role: 'worker', title: 'Builder', worktree: true },
      { role: 'reviewer', title: 'Reviewer' },
    ],
  },
  {
    id: 'leadDuo',
    emoji: '🎼',
    mode: 'auto',
    panes: [
      { role: 'lead', title: 'Lead' },
      { role: 'worker', title: 'Worker A', worktree: true },
      { role: 'worker', title: 'Worker B', worktree: true },
    ],
  },
  {
    id: 'fullSwarm',
    emoji: '🐝',
    mode: 'auto',
    panes: [
      { role: 'lead', title: 'Lead' },
      { role: 'worker', title: 'Worker A', worktree: true },
      { role: 'worker', title: 'Worker B', worktree: true },
      { role: 'reviewer', title: 'Reviewer' },
    ],
  },
  {
    id: 'parallel',
    emoji: '⚡',
    mode: 'auto',
    panes: [
      { role: 'worker', title: 'Worker A', worktree: true },
      { role: 'worker', title: 'Worker B', worktree: true },
      { role: 'worker', title: 'Worker C', worktree: true },
    ],
  },
]

// Structural twins of the store's PaneLeaf/PaneGroup (kept local so this module
// imports nothing impure; the shapes are assignable at the call site).
export interface BuiltLeaf<A> {
  type: 'leaf'
  id: string
  agentId: A
  ptyStatus: 'idle'
  taskId: null
  title?: string
  worktree?: boolean
  pendingAutoSpawn?: boolean
}

export interface BuiltGroup<A> {
  type: 'group'
  id: string
  direction: 'horizontal' | 'vertical'
  children: (BuiltLeaf<A> | BuiltGroup<A>)[]
}

export interface BuiltRecipeLayout<A> {
  root: BuiltGroup<A>
  /** Leaf id of the pane whose role is 'lead', or null when the recipe has none. */
  leadPaneId: string | null
}

/**
 * Materialise a recipe into a pane tree (two balanced columns, like the
 * workspace setup) with titles, worktree flags and queued auto-spawns. `agentId`
 * fills every pane (recipes are agent-agnostic); `newId` is injected so the
 * builder stays pure.
 */
export function buildRecipeLayout<A>(
  recipe: SwarmRecipe,
  agentId: A,
  newId: () => string,
): BuiltRecipeLayout<A> {
  let leadPaneId: string | null = null
  const leaves: BuiltLeaf<A>[] = recipe.panes.map((p) => {
    const leaf: BuiltLeaf<A> = {
      type: 'leaf',
      id: newId(),
      agentId,
      ptyStatus: 'idle',
      taskId: null,
      title: p.title,
      pendingAutoSpawn: true,
      ...(p.worktree ? { worktree: true } : {}),
    }
    if (p.role === 'lead' && leadPaneId === null) leadPaneId = leaf.id
    return leaf
  })

  const count = leaves.length
  if (count <= 1) {
    return { root: { type: 'group', id: newId(), direction: 'horizontal', children: leaves }, leadPaneId }
  }
  const rowsPerCol = Math.ceil(count / 2)
  const columns: (BuiltLeaf<A> | BuiltGroup<A>)[] = []
  let placed = 0
  for (let c = 0; c < 2 && placed < count; c++) {
    const rows = Math.min(rowsPerCol, count - placed)
    const children = leaves.slice(placed, placed + rows)
    placed += rows
    columns.push(children.length === 1 ? children[0] : { type: 'group', id: newId(), direction: 'vertical', children })
  }
  return { root: { type: 'group', id: newId(), direction: 'horizontal', children: columns }, leadPaneId }
}
