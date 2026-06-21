// SwarmAgent tool layer — the bridge between the LLM's function calls and real
// app actions. Each tool has an OpenAI/Groq-style JSON schema (sent to the
// model) plus an executor that runs in the renderer using the Zustand store and
// window.swarmmind IPC. Keep the set small and high-value; the assistant can
// always just talk when no tool fits.

import { useWorkspaceStore, buildLayoutForCount, AGENT_IDS, type AgentId, type PaneNode, type PaneLeaf } from '../store/workspace'
import { readPaneOutput } from '../hooks/usePty'

function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)
}

// Cooperative cancellation for long-running tool executors. The conversation
// loop (useSwarmAgent) checks its own cancelRef only *between* steps, so a tool
// that blocks (e.g. wait_for_agent polling for up to 10 min) would otherwise
// ignore the Stop button until it returns. The loop calls resetToolCancellation()
// at the start of each run and cancelTools() from stop()/clear(); blocking
// executors poll toolCancelled() and bail out promptly.
let _toolCancelled = false
export function cancelTools(): void { _toolCancelled = true }
export function resetToolCancellation(): void { _toolCancelled = false }
function toolCancelled(): boolean { return _toolCancelled }

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${Math.round(sec / 3600)}h`
}

function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

const paneLabel = (l: PaneLeaf) => l.title?.trim() || l.agentId || 'agent'

// Load the SwarmMind-managed worktrees (under .swarmmind/worktrees/) plus the
// base branch and a friendly label per branch (the pane's title/agent). Mirrors
// WorktreeReview.tsx's world model. Shared by review_agent_work / merge_agent_work.
async function loadManagedWorktrees(): Promise<
  | { error: string }
  | { root: string; base: string; rows: { path: string; branch: string; label: string }[] }
> {
  const st = useWorkspaceStore.getState()
  const root = st.workspace?.rootPath
  if (!root) return { error: 'Open a workspace first.' }
  if (!(await window.swarmmind.gitIsRepo(root))) {
    return { error: 'This workspace is not a git repository — there are no agent worktrees.' }
  }
  const [list, base] = await Promise.all([
    window.swarmmind.gitListWorktrees(root),
    window.swarmmind.gitBaseBranch(root),
  ])
  const managed = list.filter(w => w.path.replace(/\\/g, '/').toLowerCase().includes('.swarmmind/worktrees/'))
  const labelOf = new Map<string, string>()
  for (const l of collectLeaves(st.rootPane)) {
    if (l.worktreeBranch) labelOf.set(l.worktreeBranch, l.title?.trim() || l.agentId || l.worktreeBranch)
  }
  const rows = managed.map(w => ({ path: w.path, branch: w.branch, label: labelOf.get(w.branch) || w.branch }))
  return { root, base, rows }
}

// Resolve a single running agent pane from optional agentId/title filters,
// preferring whichever is currently `working` so "what's it doing?"-style reads
// land on the busy pane. Shared by read_agent / wait_for_agent. Returns the
// chosen pane plus how many panes matched, or a user-facing error string.
function pickAgentPane(
  agentId: AgentId | null,
  title: string,
): { pane: PaneLeaf; matchCount: number } | { error: string } {
  const st = useWorkspaceStore.getState()
  const running = collectLeaves(st.rootPane).filter(l => l.agentId && l.ptyStatus === 'running')
  if (!running.length) return { error: 'No running agent panes.' }

  let candidates = running
  if (agentId) candidates = candidates.filter(l => l.agentId === agentId)
  if (title) candidates = candidates.filter(l => (l.title ?? '').toLowerCase().includes(title))
  if (!candidates.length) {
    const who = [agentId, title && `titled "${title}"`].filter(Boolean).join(' ')
    return { error: `No running ${who || 'agent'} pane.` }
  }
  const attention = st.paneAttention
  const pane = candidates.find(l => attention[l.id] === 'working') ?? candidates[0]
  return { pane, matchCount: candidates.length }
}

// JSON schemas advertised to the model.
export const SWARM_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_workspace',
      description:
        'Switch to a DIFFERENT project folder (a new workspace) and populate it with N agent panes. This changes which folder is open. If no path is given, a folder picker is shown. Use ONLY when the user names a folder/path or explicitly wants to open another project. Do NOT use this for "the current/this/actual workspace" — use setup_agents instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the project folder. Omit to let the user pick a folder.' },
          name: { type: 'string', description: 'Optional display name for the workspace.' },
          agentCount: { type: ['integer', 'string'], description: 'How many agent panes to create (default 1).' },
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Which agent CLI to run in each pane (default "claude").' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setup_agents',
      description:
        'Populate the CURRENTLY OPEN workspace with exactly N agent panes, replacing the current pane layout. Does NOT open a folder picker and does NOT change which folder is open. Use this for "open/create/set up/give me 4 agents in the current (this/actual) workspace".',
      parameters: {
        type: 'object',
        properties: {
          count: { type: ['integer', 'string'], description: 'Exact number of agent panes the workspace should have.' },
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Which agent CLI to run in each pane (default: the configured default agent, else "claude").' },
        },
        required: ['count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_agents',
      description: 'Append N more agent panes to the currently open workspace, keeping the existing panes. Use for "add 2 more agents". To set an exact total instead, use setup_agents.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: ['integer', 'string'], description: 'How many agent panes to add.' },
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Which agent CLI to run (default: the configured default agent).' },
        },
        required: ['count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_pane_title',
      description:
        'Rename an agent pane so its label is clearer in the layout, reviews and orchestration ("call the left one backend", "name Claude\'s pane API"). Identify the pane by which agent runs in it and/or its current title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The new title for the pane.' },
          agentId: { type: 'string', enum: AGENT_IDS, description: "Which agent's pane to rename." },
          currentTitle: { type: 'string', description: 'Match the pane by its current title when several panes run the same agent.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_pane',
      description:
        "Close an agent pane and stop its agent (\"close the backend pane\", \"remove Claude's second pane\"). Identify the pane by which agent runs in it and/or its title. This kills the running agent in that pane, so confirm with the user first unless they clearly asked to close it.",
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', enum: AGENT_IDS, description: "Which agent's pane to close." },
          title: { type: 'string', description: 'Match the pane by its title when several panes run the same agent.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_default_agent',
      description: 'Set the default agent CLI used when new panes are created.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', enum: AGENT_IDS } },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List the agent CLIs that can be run in panes.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workspaces',
      description: 'List the workspaces the user has opened before.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'broadcast_prompt',
      description: 'Send a prompt/message to every running agent pane in the current workspace at once.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The prompt to send to all panes.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_loop',
      description:
        'Create a recurring "loop": a saved schedule that automatically re-sends a prompt to an agent pane every N seconds (like Claude Code\'s /loop). Use for "every 5 minutes tell Claude to run the tests", "keep checking the build", or any repeating instruction.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short schedule name, e.g. "Run tests".' },
          description: { type: 'string', description: 'A clear one-line summary of what the loop does and why, e.g. "Runs the test suite and reports failures every 5 min". Always provide one.' },
          prompt: { type: 'string', description: 'The full instruction sent to the agent on each run. It is replayed verbatim with NO conversation context, so write a complete, self-contained prompt — not a terse fragment. Spell out the task, what to do, and what to report back (e.g. "Run the full test suite with `npm test`. If anything fails, summarise which tests failed and the likely cause; otherwise reply that all tests passed."). Do not just echo the user\'s shorthand.' },
          intervalSec: { type: ['integer', 'string'], description: 'How often to run, in seconds (minimum 5).' },
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Target a running pane of this agent. Omit to send to every running agent pane.' },
        },
        required: ['name', 'prompt', 'intervalSec'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_loops',
      description: 'List the recurring loops (schedules) in the current workspace, with their name, description, interval and whether they are running.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_loop',
      description: 'Pause a running loop by name (it stops sending its prompt until resumed).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name of the loop to pause.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_loop',
      description: 'Resume a paused loop by name so it starts sending its prompt again.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name of the loop to resume.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_loop',
      description: 'Delete a loop (schedule) by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name of the loop to delete.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Summarise the current workspace: which agent panes exist and whether they are running, plus task and loop counts. Call this when the user asks "what\'s running?", "what\'s the status?", or before deciding which pane to act on.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agents_needing_attention',
      description:
        'Report which agent panes need the user right now: agents blocked waiting for input (a question or permission prompt was detected) and, secondarily, agents that finished their turn and are idle. Use for "which agents need me?", "is anything waiting on me?", "who is stuck?".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_agent',
      description: 'Send a prompt to the running pane(s) of ONE specific agent (e.g. only Claude). Use this for a targeted message; use broadcast_prompt to reach every pane at once.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Which agent to send to.' },
          text: { type: 'string', description: 'The prompt to send.' },
        },
        required: ['agentId', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_agent',
      description:
        'Read the recent terminal output of an agent pane so you can SEE what it is doing or saying. Use this to answer "what is Claude working on?", "did the build pass?", "is it stuck / waiting for input?", or to check an agent\'s result before acting. Returns the tail of the pane\'s output. Identify the pane by agent (e.g. "claude") and/or its title; omit both to read the most recently active running pane.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Read the running pane of this agent. If several panes run the same agent, the title narrows it down.' },
          title: { type: 'string', description: 'Match a pane by its (case-insensitive) title, e.g. "backend". Useful when multiple panes run the same agent.' },
          maxChars: { type: ['integer', 'string'], description: 'How many characters of recent output to return (default 1500, max 4000).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_changes',
      description:
        'Summarise what files the agents have changed in this workspace, and flag any CONTENTION (a file two or more agents are both touching — a likely merge conflict). Use for "what did the agents change?", "what files were touched?", "are there any conflicts?". Reads the live file-activity feed; no agent needs to be running.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: ['integer', 'string'], description: 'Max number of files to list (default 15).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_agent',
      description:
        'Block until an agent pane finishes its current turn and goes idle (waiting for input), then report back — optionally with its latest output. Use this AFTER send_to_agent/broadcast_prompt to do "tell Claude to run the tests and report the result", or whenever the user wants you to wait for an agent to be done before continuing. Identify the pane by agent and/or title; omit both for the most active running pane.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Wait for this agent\'s running pane.' },
          title: { type: 'string', description: 'Match a pane by its (case-insensitive) title when several run the same agent.' },
          timeoutSec: { type: ['integer', 'string'], description: 'Give up after this many seconds (default 120, max 600).' },
          includeOutput: { type: 'boolean', description: 'Include the pane\'s latest output in the result (default true).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'interrupt_agent',
      description:
        'Stop what an agent is currently doing by sending an interrupt (Escape) to its pane — use for "stop Claude", "cancel that", "interrupt it". By default sends Escape, which most coding CLIs treat as "stop the current turn". Set hard=true to send Ctrl-C instead for a stubborn agent (stronger; may cancel more aggressively). Targets the busy matching pane; identify it by agent and/or title.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', enum: AGENT_IDS, description: 'Interrupt this agent\'s running pane.' },
          title: { type: 'string', description: 'Match a pane by its (case-insensitive) title when several run the same agent.' },
          hard: { type: 'boolean', description: 'Send Ctrl-C instead of Escape for a stronger interrupt (default false).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_view',
      description: 'Open one of SwarmMind\'s views/overlays for the user (navigation).',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['terminals', 'board', 'memory', 'timeline', 'loops', 'changes', 'checkpoints', 'files', 'review', 'benchmarks', 'settings'],
            description: 'terminals = the agent panes; board = Kanban tasks; memory = memory graph; timeline = swarm activity; loops = recurring prompts; changes = file activity; checkpoints = snapshots; files = code editor; review = worktree review; benchmarks; settings.',
          },
        },
        required: ['view'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a task on the workspace Kanban board / shared task queue. Optionally assign it to an agent so the orchestrator can dispatch it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title.' },
          description: { type: 'string', description: 'Optional details.' },
          assignedAgent: { type: 'string', enum: AGENT_IDS, description: 'Optional agent to assign the task to.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List tasks on the board, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'needs_review', 'done', 'failed'], description: 'Optional status filter.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Change a task\'s status, matched by its title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task\'s title (or a distinctive part of it).' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'needs_review', 'done', 'failed'] },
        },
        required: ['title', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save a note to the workspace\'s shared memory so the agents (and you) can recall it later.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'A short key/label for the note.' },
          value: { type: 'string', description: 'The content to remember.' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search the workspace\'s shared memory and return the most relevant entries.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_agent_work',
      description:
        "Summarise the git changes in each agent's isolated worktree branch versus the main checkout: files changed with +/- line counts, how many commits ahead, and whether there are still uncommitted edits. Use for \"what did the agents build?\", \"is anything ready to merge?\", \"review the agents' work\". Read-only.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_agent_work',
      description:
        "Merge one agent's worktree branch into the main branch so its work lands (\"merge Claude's branch\", \"land the backend work\"). Identify the worktree by branch name or pane title; if there is only one, the name can be omitted. Any uncommitted changes in the worktree are committed first. On a merge conflict it aborts cleanly and leaves the main checkout untouched. This modifies the main branch — confirm with the user before doing it unless they clearly asked to merge.",
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'The worktree branch name or its pane title (a distinctive part is enough). Omit only when there is a single worktree.' },
          message: { type: 'string', description: 'Optional commit message, used only if there are uncommitted changes to commit before merging.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discard_agent_work',
      description:
        "Discard an agent's worktree branch entirely — removes the worktree and deletes its branch, throwing away that branch's uncommitted and committed work (\"discard Claude's branch\", \"throw away the failed experiment\"). Identify it by branch name or pane title; if there is only one, the name can be omitted. This is destructive and cannot be undone, so confirm with the user first unless they clearly asked to discard it.",
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'The worktree branch name or its pane title (a distinctive part is enough). Omit only when there is a single worktree.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_checkpoint',
      description:
        'Save a checkpoint: a whole-workspace git snapshot the user can roll back to later. Use for "save a checkpoint", "snapshot this before the risky change", "checkpoint before you refactor". Give it a short, descriptive label so it is easy to find when restoring.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'A short, descriptive name for the snapshot, e.g. "Before auth refactor". Always provide one.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_checkpoints',
      description: 'List the saved checkpoints (workspace snapshots) for the current workspace, newest first, with their label and how long ago they were taken. Use before restoring so you (and the user) can pick the right one.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_checkpoint',
      description:
        'Roll the whole workspace back to a saved checkpoint ("rewind", "go back to the checkpoint before the refactor", "restore the snapshot"). Identify it by label (a distinctive part is enough); omit the label to restore the most recent checkpoint. This overwrites current files, but a safety checkpoint of the current state is taken first so the rewind itself can be undone. Confirm with the user before restoring unless they clearly asked for it.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The checkpoint label (or a distinctive part of it). Omit to restore the most recent checkpoint.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_orchestration',
      description: 'Kick off the autonomous orchestrator (Conductor). With a goal, the first running pane becomes the lead and decomposes it into tasks for the other panes; without a goal, it dispatches existing pending tasks to free panes. Agent panes must already be running.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Optional high-level goal for the lead to break down.' },
          mode: { type: 'string', enum: ['auto', 'assisted'], description: 'auto dispatches automatically; assisted asks the user to approve each dispatch. Default auto.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_orchestration',
      description: 'Stop the orchestrator and turn the Conductor off.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const

type Args = Record<string, unknown>
type Executor = (args: Args) => Promise<string>

export const TOOL_EXECUTORS: Record<string, Executor> = {
  async open_workspace(args) {
    const store = useWorkspaceStore.getState()
    const agentId: AgentId = isAgentId(args.agentId) ? args.agentId : 'claude'
    const count = Math.max(1, Math.min(16, Number(args.agentCount) || 1))

    let info: { id: string; name: string; rootPath: string; error?: string } | null = null
    if (typeof args.path === 'string' && args.path.trim()) {
      info = await window.swarmmind.workspaceOpenByPath(
        args.path.trim(),
        typeof args.name === 'string' ? args.name : undefined,
      )
    } else {
      // No path → native folder picker (workspace:open opens the dialog).
      info = await window.swarmmind.workspaceOpen()
    }
    if (!info || info.error) return `Could not open the workspace${info?.error ? `: ${info.error}` : ' (no folder selected).'}`

    store.setDefaultAgentId(agentId)
    store.setWorkspace({ id: info.id, name: info.name, rootPath: info.rootPath })
    store.setLayout(buildLayoutForCount(count, agentId))
    return `Opened workspace "${info.name}" with ${count} ${agentId} agent${count === 1 ? '' : 's'}.`
  },

  async setup_agents(args) {
    const store = useWorkspaceStore.getState()
    if (!store.workspace) return 'No workspace is open yet — open one first (e.g. "open a workspace with 4 agents").'
    const agentId: AgentId = isAgentId(args.agentId) ? args.agentId : (store.defaultAgentId ?? 'claude')
    const count = Math.max(1, Math.min(16, Number(args.count) || 1))
    store.setDefaultAgentId(agentId)
    store.setLayout(buildLayoutForCount(count, agentId))
    return `Set up "${store.workspace.name}" with ${count} ${agentId} agent pane${count === 1 ? '' : 's'}.`
  },

  async add_agents(args) {
    const store = useWorkspaceStore.getState()
    if (!store.workspace) return 'No workspace is open yet — open one first.'
    const agentId: AgentId | undefined = isAgentId(args.agentId) ? args.agentId : undefined
    const count = Math.max(1, Math.min(16, Number(args.count) || 1))
    for (let i = 0; i < count; i++) store.addPane(agentId)
    const label = agentId ?? store.defaultAgentId ?? 'default'
    return `Added ${count} ${label} agent pane${count === 1 ? '' : 's'}.`
  },

  async set_pane_title(args) {
    const st = useWorkspaceStore.getState()
    if (!st.workspace) return 'Open a workspace first.'
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return 'What should the new title be?'
    const wantAgent = isAgentId(args.agentId) ? args.agentId : null
    const wantTitle = typeof args.currentTitle === 'string' ? args.currentTitle.trim().toLowerCase() : ''
    let panes = collectLeaves(st.rootPane).filter(l => l.agentId)
    if (wantAgent) panes = panes.filter(l => l.agentId === wantAgent)
    if (wantTitle) panes = panes.filter(l => (l.title ?? '').toLowerCase().includes(wantTitle))
    if (!panes.length) return 'No matching agent pane to rename.'
    if (panes.length > 1) {
      return `Several panes match (${panes.map(paneLabel).join(', ')}). Say which agent or current title to pick one.`
    }
    const prev = paneLabel(panes[0])
    st.setPaneTitle(panes[0].id, title)
    return `Renamed ${prev} to "${title}".`
  },

  async close_pane(args) {
    const st = useWorkspaceStore.getState()
    if (!st.workspace) return 'Open a workspace first.'
    const wantAgent = isAgentId(args.agentId) ? args.agentId : null
    const wantTitle = typeof args.title === 'string' ? args.title.trim().toLowerCase() : ''
    let panes = collectLeaves(st.rootPane).filter(l => l.agentId)
    if (wantAgent) panes = panes.filter(l => l.agentId === wantAgent)
    if (wantTitle) panes = panes.filter(l => (l.title ?? '').toLowerCase().includes(wantTitle))
    if (!panes.length) return 'No matching agent pane to close.'
    if (panes.length > 1) {
      return `Several panes match (${panes.map(paneLabel).join(', ')}). Say which agent or title to pick one.`
    }
    const label = paneLabel(panes[0])
    st.closePane(panes[0].id)
    return `Closed the ${label} pane and stopped its agent.`
  },

  async set_default_agent(args) {
    if (!isAgentId(args.agentId)) return `Unknown agent "${String(args.agentId)}".`
    useWorkspaceStore.getState().setDefaultAgentId(args.agentId)
    return `Default agent set to ${args.agentId}.`
  },

  async list_agents() {
    return `Available agents: ${AGENT_IDS.join(', ')}.`
  },

  async list_workspaces() {
    const list = (await window.swarmmind.workspaceList()) as { name?: string }[]
    if (!list?.length) return 'No workspaces yet.'
    return `Workspaces: ${list.map(w => w.name).filter(Boolean).join(', ')}.`
  },

  async broadcast_prompt(args) {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text.trim()) return 'Nothing to broadcast (empty text).'
    const ids = useWorkspaceStore.getState().getLeafIds()
    if (!ids.length) return 'No panes to broadcast to.'
    for (const id of ids) window.swarmmind.ptyInput(id, text.endsWith('\n') ? text : text + '\n')
    return `Sent the prompt to ${ids.length} pane${ids.length === 1 ? '' : 's'}.`
  },

  async create_loop(args) {
    const store = useWorkspaceStore.getState()
    if (!store.workspace) return 'No workspace is open — open one first.'
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) return 'A loop needs a prompt to send.'
    const intervalSec = Math.max(5, Math.round(Number(args.intervalSec)) || 60)

    // Resolve the target: a specific agent's running pane, or all running panes.
    let paneId: string | null = null
    let agentId: AgentId | null = null
    if (isAgentId(args.agentId)) {
      agentId = args.agentId
      const pane = collectLeaves(store.rootPane).find(l => l.agentId === agentId && l.ptyStatus === 'running')
      // Bind to that agent's running pane; if none is running, fall back to
      // broadcasting to every running agent pane (paneId stays null).
      if (pane) paneId = pane.id
    }

    const loop = store.addLoop({
      name: typeof args.name === 'string' ? args.name : 'Loop',
      description: typeof args.description === 'string' ? args.description : '',
      prompt,
      intervalSec,
      paneId,
      agentId,
    })
    const target = paneId ? (agentId ?? 'a pane') : 'all running agents'
    return `Created loop "${loop.name}" — sends its prompt to ${target} every ${formatInterval(intervalSec)}. It's running now.`
  },

  async list_loops() {
    const loops = useWorkspaceStore.getState().loops
    if (!loops.length) return 'No loops yet.'
    return loops
      .map(l => {
        const state = l.enabled ? 'running' : 'paused'
        const desc = l.description ? ` — ${l.description}` : ''
        return `"${l.name}"${desc} (every ${formatInterval(l.intervalSec)}, ${state}, ${l.runCount} run${l.runCount === 1 ? '' : 's'})`
      })
      .join('; ')
  },

  async stop_loop(args) {
    const store = useWorkspaceStore.getState()
    const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
    const loop = store.loops.find(l => l.name.toLowerCase() === name) ?? store.loops.find(l => l.name.toLowerCase().includes(name))
    if (!loop) return `No loop named "${String(args.name)}".`
    store.setLoopEnabled(loop.id, false)
    return `Paused loop "${loop.name}".`
  },

  async start_loop(args) {
    const store = useWorkspaceStore.getState()
    const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
    const loop = store.loops.find(l => l.name.toLowerCase() === name) ?? store.loops.find(l => l.name.toLowerCase().includes(name))
    if (!loop) return `No loop named "${String(args.name)}".`
    store.setLoopEnabled(loop.id, true)
    return `Resumed loop "${loop.name}".`
  },

  async delete_loop(args) {
    const store = useWorkspaceStore.getState()
    const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
    const loop = store.loops.find(l => l.name.toLowerCase() === name) ?? store.loops.find(l => l.name.toLowerCase().includes(name))
    if (!loop) return `No loop named "${String(args.name)}".`
    store.removeLoop(loop.id)
    return `Deleted loop "${loop.name}".`
  },

  async get_status() {
    const st = useWorkspaceStore.getState()
    if (!st.workspace) return 'No workspace is open.'
    const leaves = collectLeaves(st.rootPane).filter(l => l.agentId)
    const running = leaves.filter(l => l.ptyStatus === 'running')
    const paneDesc = leaves.length
      ? leaves.map(l => `${l.title?.trim() || l.agentId}${l.ptyStatus === 'running' ? ' (running)' : ' (idle)'}`).join(', ')
      : 'no agent panes'
    let taskSummary = ' No tasks.'
    try {
      const tasks = (await window.swarmmind.taskList()) as { status: string }[]
      if (tasks?.length) {
        const by = (s: string) => tasks.filter(t => t.status === s).length
        taskSummary = ` Tasks: ${tasks.length} (${by('pending')} pending, ${by('in_progress')} in progress, ${by('done')} done).`
      }
    } catch { /* task DB unavailable */ }
    const loopCount = st.loops.filter(l => l.enabled).length + st.cliLoops.length
    return `Workspace "${st.workspace.name}": ${leaves.length} agent pane(s) [${paneDesc}], ${running.length} running.${taskSummary} ${loopCount} loop(s) active.`
  },

  async agents_needing_attention() {
    const st = useWorkspaceStore.getState()
    if (!st.workspace) return 'Open a workspace first.'
    const leaves = collectLeaves(st.rootPane)
    const labelById = new Map(leaves.map(l => [l.id, paneLabel(l)]))

    // Precise signal: the question-gated "needs you" notifications (unread).
    const blocked = st.notifications.filter(n => !n.read)
    const blockedPaneIds = new Set(blocked.map(n => n.paneId))
    // Secondary: running panes that finished a turn and went idle ('waiting'),
    // excluding any already covered by a blocked notification.
    const idle = leaves.filter(
      l => l.agentId && l.ptyStatus === 'running' && st.paneAttention[l.id] === 'waiting' && !blockedPaneIds.has(l.id),
    )

    if (!blocked.length && !idle.length) return 'No agents need your attention right now.'
    const parts: string[] = []
    if (blocked.length) {
      const names = blocked.map(n => n.paneTitle?.trim() || labelById.get(n.paneId) || n.agentId || 'agent')
      parts.push(`${blocked.length} waiting for input: ${names.join(', ')}.`)
    }
    if (idle.length) parts.push(`${idle.length} finished a turn and idle: ${idle.map(paneLabel).join(', ')}.`)
    return parts.join(' ')
  },

  async send_to_agent(args) {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text.trim()) return 'Nothing to send (empty text).'
    if (!isAgentId(args.agentId)) return `Unknown agent "${String(args.agentId)}".`
    const agentId = args.agentId
    const targets = collectLeaves(useWorkspaceStore.getState().rootPane)
      .filter(l => l.agentId === agentId && l.ptyStatus === 'running')
    if (!targets.length) return `No running ${agentId} pane.`
    for (const t of targets) {
      window.swarmmind.ptyInput(t.id, text)
      window.swarmmind.ptyInput(t.id, '\r')
    }
    return `Sent to ${targets.length} ${agentId} pane${targets.length === 1 ? '' : 's'}.`
  },

  async read_agent(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const maxChars = Math.max(200, Math.min(4000, Number(args.maxChars) || 1500))
    const picked = pickAgentPane(
      isAgentId(args.agentId) ? args.agentId : null,
      typeof args.title === 'string' ? args.title.trim().toLowerCase() : '',
    )
    if ('error' in picked) return picked.error
    const { pane, matchCount } = picked

    const label = paneLabel(pane)
    const output = readPaneOutput(pane.id, maxChars)
    if (!output) return `${label} has no captured output yet (it may have just started).`
    const more = matchCount > 1 ? ` (${matchCount} matching panes; reading "${label}")` : ''
    return `Recent output from ${label}${more}:\n\n${output}`
  },

  async get_changes(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15))
    const events = (await window.swarmmind.eventsList(undefined, 600, ['file_changed', 'contention', 'file_intent'])) as SwarmEvent[]
    if (!events?.length) return 'No file changes recorded yet for this workspace.'

    // Aggregate per file: who changed it, how many times, latest activity, and
    // whether it's contended — mirrors the Changes panel's world model.
    const map = new Map<string, { agents: Set<string>; count: number; lastTs: number; contended: boolean }>()
    const ensure = (p: string) => {
      let e = map.get(p)
      if (!e) { e = { agents: new Set(), count: 0, lastTs: 0, contended: false }; map.set(p, e) }
      return e
    }
    for (const ev of events) {
      const d = ev.payload ?? {}
      if (ev.type === 'file_changed' && typeof d.path === 'string') {
        const e = ensure(d.path)
        if (ev.agent_id) e.agents.add(ev.agent_id)
        e.count += 1
        e.lastTs = Math.max(e.lastTs, ev.ts)
      } else if (ev.type === 'contention' && typeof d.path === 'string') {
        const e = ensure(d.path)
        e.contended = true
        e.lastTs = Math.max(e.lastTs, ev.ts)
        if (Array.isArray(d.agents)) for (const a of d.agents) if (typeof a === 'string') e.agents.add(a)
      }
    }
    if (!map.size) return 'No file changes recorded yet for this workspace.'

    const all = Array.from(map.entries()).sort(([, a], [, b]) => {
      if (a.contended !== b.contended) return a.contended ? -1 : 1
      return b.lastTs - a.lastTs
    })
    const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p
    const describe = ([path, e]: [string, { agents: Set<string>; count: number; contended: boolean }]) => {
      const who = Array.from(e.agents).join(', ') || 'unknown'
      const flag = e.contended ? '⚠ contended — ' : ''
      const times = e.count > 1 ? `, ${e.count}×` : ''
      return `${flag}${base(path)} (${who}${times})`
    }

    const contended = all.filter(([, e]) => e.contended)
    const shown = all.slice(0, limit)
    const header = `${all.length} file${all.length === 1 ? '' : 's'} changed${contended.length ? `, ${contended.length} contended (possible conflict)` : ''}.`
    const list = shown.map(describe).join('\n')
    const trailer = all.length > shown.length ? `\n…and ${all.length - shown.length} more.` : ''
    return `${header}\n${list}${trailer}`
  },

  async wait_for_agent(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const picked = pickAgentPane(
      isAgentId(args.agentId) ? args.agentId : null,
      typeof args.title === 'string' ? args.title.trim().toLowerCase() : '',
    )
    if ('error' in picked) return picked.error
    const { pane } = picked
    const paneId = pane.id
    const label = paneLabel(pane)
    const timeoutMs = Math.max(5, Math.min(600, Number(args.timeoutSec) || 120)) * 1000
    const wantOutput = args.includeOutput !== false

    const attentionOf = () => useWorkspaceStore.getState().paneAttention[paneId]
    const stillRunning = () =>
      collectLeaves(useWorkspaceStore.getState().rootPane).some(l => l.id === paneId && l.ptyStatus === 'running')

    // Poll the pane's activity signal until it goes quiet ('waiting'). A prompt
    // was likely just sent, so give it a short grace window to *start* working
    // before concluding it's already idle — otherwise we'd return instantly on a
    // pane that hasn't reacted yet. Once we've seen it work, the flip back to
    // 'waiting' means the turn finished.
    const POLL_MS = 400
    const START_GRACE_MS = 6000
    const t0 = Date.now()
    let sawWorking = attentionOf() === 'working'
    let outcome: 'done' | 'timeout' | 'exited' | 'cancelled' = 'timeout'

    while (Date.now() - t0 < timeoutMs) {
      if (toolCancelled()) { outcome = 'cancelled'; break }
      if (!stillRunning()) { outcome = 'exited'; break }
      const state = attentionOf()
      if (state === 'working') sawWorking = true
      if (state === 'waiting' && (sawWorking || Date.now() - t0 > START_GRACE_MS)) { outcome = 'done'; break }
      await new Promise(r => setTimeout(r, POLL_MS))
    }

    const tail = wantOutput ? readPaneOutput(paneId, 1500) : ''
    const suffix = tail ? `\n\nLatest output:\n\n${tail}` : ''
    if (outcome === 'cancelled') return `Stopped waiting for ${label}.`
    if (outcome === 'exited') return `${label} stopped running before it finished.${suffix}`
    if (outcome === 'timeout') return `${label} is still working after ${Math.round(timeoutMs / 1000)}s (timed out waiting).${suffix}`
    return `${label} finished its turn and is now idle.${suffix}`
  },

  async interrupt_agent(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const picked = pickAgentPane(
      isAgentId(args.agentId) ? args.agentId : null,
      typeof args.title === 'string' ? args.title.trim().toLowerCase() : '',
    )
    if ('error' in picked) return picked.error
    const { pane } = picked
    const hard = args.hard === true
    // Escape = "stop the current turn" in most coding TUIs; Ctrl-C is the harder
    // SIGINT escalation. Raw control byte straight to the PTY.
    window.swarmmind.ptyInput(pane.id, hard ? '\x03' : '\x1b')
    return `Sent ${hard ? 'Ctrl-C' : 'Escape'} to ${paneLabel(pane)} to interrupt it.`
  },

  async open_view(args) {
    const st = useWorkspaceStore.getState()
    const view = String(args.view ?? '').toLowerCase()
    if (view === 'settings') { st.openSettings(); return 'Opened Settings.' }
    if (!st.workspace) return 'Open a workspace first.'
    const ensure = (open: boolean, toggle: () => void, label: string) => {
      if (!open) toggle()
      return `Opened the ${label}.`
    }
    switch (view) {
      case 'terminals': st.showTerminals(); return 'Showing the terminal panes.'
      case 'board': return ensure(st.boardOpen, st.toggleBoard, 'Kanban board')
      case 'memory': return ensure(st.graphOpen, st.toggleGraph, 'memory graph')
      case 'timeline': return ensure(st.timelineOpen, st.toggleTimeline, 'swarm timeline')
      case 'loops': return ensure(st.loopsOpen, st.toggleLoops, 'Loops panel')
      case 'changes': return ensure(st.changesOpen, st.toggleChanges, 'Changes panel')
      case 'checkpoints': return ensure(st.checkpointsOpen, st.toggleCheckpoints, 'Checkpoints panel')
      case 'files': return ensure(st.filePanelOpen, st.toggleFilePanel, 'file editor')
      case 'review': return ensure(st.reviewOpen, st.toggleReview, 'worktree review')
      case 'benchmarks': return ensure(st.benchmarksOpen, st.toggleBenchmarks, 'benchmarks')
      default: return `Unknown view "${view}".`
    }
  },

  async create_task(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return 'A task needs a title.'
    const assigned = isAgentId(args.assignedAgent) ? args.assignedAgent : undefined
    await window.swarmmind.taskCreate(title, typeof args.description === 'string' ? args.description : undefined, assigned)
    return `Created task "${title}"${assigned ? ` (assigned to ${assigned})` : ''}.`
  },

  async list_tasks(args) {
    const status = typeof args.status === 'string' ? args.status : undefined
    const tasks = (await window.swarmmind.taskList(status)) as { title: string; status: string; assigned_agent: string | null }[]
    if (!tasks?.length) return status ? `No ${status} tasks.` : 'No tasks yet.'
    return tasks.map(t => `"${t.title}" [${t.status}]${t.assigned_agent ? ` → ${t.assigned_agent}` : ''}`).join('; ')
  },

  async update_task(args) {
    const status = typeof args.status === 'string' ? args.status : ''
    const valid = ['pending', 'in_progress', 'needs_review', 'done', 'failed']
    if (!valid.includes(status)) return `Status must be one of: ${valid.join(', ')}.`
    const name = typeof args.title === 'string' ? args.title.trim().toLowerCase() : ''
    if (!name) return 'Which task? Provide its title.'
    const tasks = (await window.swarmmind.taskList()) as { id: string; title: string }[]
    const task = tasks.find(t => t.title.toLowerCase() === name) ?? tasks.find(t => t.title.toLowerCase().includes(name))
    if (!task) return `No task matching "${String(args.title)}".`
    await window.swarmmind.taskUpdate(task.id, status)
    return `Set "${task.title}" to ${status}.`
  },

  async remember(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const key = typeof args.key === 'string' ? args.key.trim() : ''
    const value = typeof args.value === 'string' ? args.value : ''
    if (!key || !value) return 'I need both a key and a value to remember.'
    await window.swarmmind.memoryWrite(key, value, 'context')
    return `Saved "${key}" to shared memory.`
  },

  async recall(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query.trim()) return 'What should I recall?'
    const hits = (await window.swarmmind.memorySearch(query, 5)) as { key: string; value: string }[]
    if (!hits?.length) return `Nothing in shared memory about "${query}".`
    return hits.map(h => `${h.key}: ${h.value.slice(0, 160)}`).join(' | ')
  },

  async review_agent_work() {
    const r = await loadManagedWorktrees()
    if ('error' in r) return r.error
    if (!r.rows.length) return 'No agent worktrees to review (no per-pane git worktrees exist).'
    const lines: string[] = []
    for (const w of r.rows) {
      const stat = await window.swarmmind.gitWorktreeDiffStat(r.root, w.path, r.base)
      const adds = stat.files.reduce((n, f) => n + f.additions, 0)
      const dels = stat.files.reduce((n, f) => n + f.deletions, 0)
      if (!stat.files.length && !stat.ahead) {
        lines.push(`${w.label}: no changes vs ${r.base}`)
      } else {
        const dirty = stat.hasUncommitted ? ', uncommitted edits' : ''
        lines.push(
          `${w.label}: ${stat.files.length} file${stat.files.length === 1 ? '' : 's'} (+${adds}/-${dels}), ${stat.ahead} commit${stat.ahead === 1 ? '' : 's'} ahead of ${r.base}${dirty}`,
        )
      }
    }
    return `Agent worktrees vs ${r.base}:\n${lines.join('\n')}`
  },

  async merge_agent_work(args) {
    const r = await loadManagedWorktrees()
    if ('error' in r) return r.error
    if (!r.rows.length) return 'No agent worktrees to merge.'
    const q = typeof args.branch === 'string' ? args.branch.trim().toLowerCase() : ''
    let row = !q && r.rows.length === 1 ? r.rows[0] : undefined
    if (!row && q) {
      row = r.rows.find(w => w.branch.toLowerCase() === q || w.label.toLowerCase() === q)
        ?? r.rows.find(w => w.branch.toLowerCase().includes(q) || w.label.toLowerCase().includes(q))
    }
    if (!row) {
      const avail = r.rows.map(w => `"${w.label}"`).join(', ')
      return q ? `No worktree matching "${String(args.branch)}". Available: ${avail}.` : `Which worktree? Available: ${avail}.`
    }
    // Nothing to land — avoid a misleading "merged" message for a no-op merge.
    const stat = await window.swarmmind.gitWorktreeDiffStat(r.root, row.path, r.base)
    if (!stat.hasUncommitted && stat.ahead === 0) {
      return `${row.label} has no changes to merge — it's already even with ${r.base}.`
    }
    // Commit any uncommitted work first so the merge includes it.
    if (stat.hasUncommitted) {
      const msg = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : `Work from ${row.label}`
      const committed = await window.swarmmind.gitWorktreeCommit(row.path, msg)
      if ('error' in committed) return `Couldn't commit ${row.label}'s changes before merging: ${committed.error}`
    }
    const res = await window.swarmmind.gitMergeBranch(r.root, row.branch)
    if (!res.ok) {
      return res.conflict
        ? `Merging ${row.label} into ${r.base} hit conflicts and was aborted — your ${r.base} checkout is unchanged. Open Worktree Review to resolve it.`
        : `Couldn't merge ${row.label}: ${res.error}`
    }
    return `Merged ${row.label} into ${r.base}. ${res.message}`
  },

  async discard_agent_work(args) {
    const r = await loadManagedWorktrees()
    if ('error' in r) return r.error
    if (!r.rows.length) return 'No agent worktrees to discard.'
    const q = typeof args.branch === 'string' ? args.branch.trim().toLowerCase() : ''
    let row = !q && r.rows.length === 1 ? r.rows[0] : undefined
    if (!row && q) {
      row = r.rows.find(w => w.branch.toLowerCase() === q || w.label.toLowerCase() === q)
        ?? r.rows.find(w => w.branch.toLowerCase().includes(q) || w.label.toLowerCase().includes(q))
    }
    if (!row) {
      const avail = r.rows.map(w => `"${w.label}"`).join(', ')
      return q ? `No worktree matching "${String(args.branch)}". Available: ${avail}.` : `Which worktree? Available: ${avail}.`
    }
    const res = await window.swarmmind.gitRemoveWorktree(r.root, row.path, row.branch, true)
    if ('error' in res) return `Couldn't discard ${row.label}: ${res.error}`
    return `Discarded ${row.label} — removed its worktree and deleted the branch.`
  },

  async create_checkpoint(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    const rec = await window.swarmmind.checkpointCreate(label || undefined, 'swarmagent')
    if ('error' in rec) return `Couldn't create a checkpoint: ${rec.error}`
    return `Saved checkpoint "${rec.label}" (${rec.trees.length} folder${rec.trees.length === 1 ? '' : 's'}). You can rewind to it later.`
  },

  async list_checkpoints() {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const list = await window.swarmmind.checkpointList()
    if (!list?.length) return 'No checkpoints saved yet.'
    return list
      .map(c => `"${c.label}" (${timeAgo(c.ts)})`)
      .join('; ')
  },

  async restore_checkpoint(args) {
    if (!useWorkspaceStore.getState().workspace) return 'Open a workspace first.'
    const list = await window.swarmmind.checkpointList()
    if (!list?.length) return 'No checkpoints to restore — none have been saved yet.'
    const name = typeof args.label === 'string' ? args.label.trim().toLowerCase() : ''
    // checkpointList is newest-first, so list[0] is the most recent.
    const rec = name
      ? (list.find(c => c.label.toLowerCase() === name) ?? list.find(c => c.label.toLowerCase().includes(name)))
      : list[0]
    if (!rec) return `No checkpoint matching "${String(args.label)}". Saved: ${list.map(c => `"${c.label}"`).join(', ')}.`
    const result = await window.swarmmind.checkpointRestore(rec.id)
    if ('error' in result) return `Couldn't restore "${rec.label}": ${result.error}`
    const errs = result.errors.length ? ` (${result.errors.length} folder${result.errors.length === 1 ? '' : 's'} had issues)` : ''
    return `Rewound the workspace to "${rec.label}" — restored ${result.restored} folder${result.restored === 1 ? '' : 's'}${errs}. A safety checkpoint of the previous state was saved first.`
  },

  async start_orchestration(args) {
    const st = useWorkspaceStore.getState()
    if (!st.workspace) return 'Open a workspace first.'
    const running = collectLeaves(st.rootPane).filter(l => l.agentId && l.ptyStatus === 'running')
    if (running.length === 0) return 'No running agent panes — spawn agents first, then start orchestration.'
    const mode = args.mode === 'assisted' ? 'assisted' : 'auto'
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    st.setOrchestrationMode(mode)
    if (goal) {
      st.setOrchestratorGoal(goal)
      st.setLeadPaneId(running[0].id) // first running pane leads the decomposition
    }
    st.startOrchestration()
    return goal
      ? `Started orchestration (${mode}). The lead pane will break down: "${goal}".`
      : `Started orchestration (${mode}) — dispatching pending tasks to ${running.length} running pane(s).`
  },

  async stop_orchestration() {
    const st = useWorkspaceStore.getState()
    st.stopOrchestration()
    st.setOrchestrationMode('off')
    return 'Stopped orchestration and turned the Conductor off.'
  },
}

export async function runTool(name: string, rawArgs: string): Promise<string> {
  const exec = TOOL_EXECUTORS[name]
  if (!exec) return `Unknown tool: ${name}`
  let args: Args = {}
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Args) : {}
  } catch {
    return `Could not parse arguments for ${name}.`
  }
  try {
    return await exec(args)
  } catch (err) {
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
