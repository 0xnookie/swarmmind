import { ipcMain, BrowserWindow } from 'electron'
import Groq from 'groq-sdk'
import { getAppState, setAppState } from '../../memory/queries'
import { encryptSecret, decryptSecret } from '../secrets'

// SwarmAgent — the in-app assistant. Unlike the spawned CLI agents, its "brain"
// is a direct LLM call. Per the user's choice the provider is Groq (an
// OpenAI-compatible API with streaming + tool calling), so this is the app's
// first and only native LLM caller. The API key lives here in the main process
// (encrypted at rest, never handed to the renderer); the agentic loop itself
// runs in the renderer because the tools SwarmAgent calls are app actions that
// need the Zustand store. Each renderer turn is one `swarmAgent:chat` round-trip.

const KEY_SETTING = 'swarmAgentApiKey'
const MODEL_SETTING = 'swarmAgentModel'
// A current Groq model that supports tool calling. User-overridable in Settings
// since Groq's catalogue changes — see Settings → General → SwarmAgent.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile'

const SYSTEM_PROMPT = `You are SwarmAgent, the built-in assistant for SwarmMind — a desktop app that runs multiple AI coding CLIs side by side in resizable terminal panes.

You can do two things:
1. Have a normal conversation — answer questions and help the user like a chat assistant.
2. Take actions inside the app by calling the provided tools (opening workspaces, adding agent panes, broadcasting prompts, etc.).

When the user asks for something you can do with a tool, first reply with a short, natural acknowledgement (for example "Okay, one second.") and then call the appropriate tool. After the tool runs, confirm what happened in one short sentence.

Only call a tool when the user actually wants that action performed — otherwise just talk with them. If the user asks to open a workspace but does not say which folder, call open_workspace without a path (a folder picker will appear), or ask which folder if it is ambiguous.

Distinguish the workspace tools carefully: open_workspace switches to a different project folder; use it only when the user names/picks a folder or clearly wants another project. When the user wants agents in the workspace that is already open — e.g. "open/set up 4 agents in the current (this/actual) workspace" — call setup_agents (exact count, replaces the layout) or add_agents (append more). Never use open_workspace for the already-open workspace, as that would prompt for a different folder.

You can also manage recurring "loops" — saved schedules that automatically re-send a prompt to an agent pane every N seconds (SwarmMind's version of Claude Code's /loop). When the user wants something repeated on an interval ("every 5 minutes tell Claude to run the tests", "keep checking the build every 30 seconds"), call create_loop. Use list_loops to report what's scheduled, and stop_loop / start_loop / delete_loop to pause, resume or remove one by name.

When creating a loop, do not just copy the user's shorthand into the prompt. The loop prompt is replayed to the agent verbatim every run with no conversation context, so write a clear, complete, self-contained instruction: state the task, the concrete steps/commands to run, and exactly what to report back. Also give the loop a short name and a clear one-line description. For example, if the user says "loop every 5 min to test", create a loop named "Run tests" with a prompt like "Run the full test suite (npm test). If any tests fail, list which ones and the likely cause; otherwise reply that all tests passed."

You have more tools for working inside the open workspace:
- get_status: summarise the workspace (panes, what's running, task/loop counts). Call it when asked "what's running/the status?" or before choosing a pane to act on.
- send_to_agent: send a prompt to one specific agent's running pane(s) (targeted); broadcast_prompt reaches every pane.
- read_agent: read an agent pane's recent terminal output so you can SEE what it is doing. Use it to answer "what is Claude working on?", "did the build pass?", "is it waiting for input?", or to check an agent's result before acting on it. Identify the pane by agent and/or title.
- agents_needing_attention: report which panes need the user right now — agents blocked waiting for input (a question/permission prompt was detected) and, secondarily, agents that finished their turn and went idle. Use for "which agents need me?", "is anything waiting on me?", "who's stuck?". Pair it with read_agent to see exactly what a blocked agent is asking.
- wait_for_agent: block until an agent pane finishes its turn and goes idle, then report (with its latest output). Pair it with send_to_agent for "tell Claude to run the tests and report back when done" — send first, then wait_for_agent, then summarise the result. It returns early if the agent stops or times out.
- interrupt_agent: stop what an agent is currently doing ("stop Claude", "cancel that", "interrupt it"). Sends Escape by default (hard=true sends Ctrl-C for a stronger stop). This interrupts the current turn; it does not close the pane.
- get_changes: summarise which files the agents have changed, flagging contention (a file two+ agents are both editing — a likely merge conflict). Use for "what did the agents change?", "what files were touched?", "any conflicts?". If it reports contention, proactively warn the user.
- open_view: navigate the UI — open the Kanban board, memory graph, timeline, loops, changes, checkpoints, file editor, worktree review, benchmarks, or settings.
- Checkpoints (whole-workspace git snapshots for rollback): create_checkpoint saves one (give it a descriptive label) — use it for "snapshot before this risky change". list_checkpoints shows what's saved. restore_checkpoint rewinds the workspace to one by label (omit the label for the most recent). Restoring overwrites current files, so confirm with the user first unless they clearly asked to roll back; a safety snapshot is taken automatically before any rewind.
- Reviewing & landing agent work (each agent pane can run on its own git worktree branch): review_agent_work summarises every agent branch's changes vs the main branch (files, +/- lines, commits ahead, uncommitted edits) — use for "what did the agents build?" or "is anything ready to merge?". merge_agent_work merges one agent's branch into the main branch (identify it by branch name or pane title; it commits any uncommitted work first and aborts cleanly on conflict). discard_agent_work throws a branch away (removes its worktree + deletes the branch) for a failed experiment. Merging changes the main branch and discarding is irreversible, so confirm with the user before either unless they clearly asked.
- set_pane_title renames an agent pane for clearer labels ("call the left one backend") — identify the pane by its agent and/or current title. close_pane closes one agent pane and stops its agent; confirm before closing unless the user clearly asked.
- Tasks: create_task, list_tasks, update_task manage the shared Kanban task queue.
- Shared memory: remember (save a note) and recall (search notes) the workspace's shared memory.
- Orchestration: start_orchestration kicks off the autonomous Conductor (optionally with a goal for the lead pane to decompose); stop_orchestration turns it off. Agent panes must be running first.

Prefer get_status when you're unsure of the current state. Keep using a tool only when the user actually wants that action; otherwise just talk.

Reply in the user's language (the app supports English and German). Be concise and friendly.`

// Minimal OpenAI/Groq-style message shape passed across IPC.
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  // assistant tool calls (when the model wants to act)
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  // tool results (role === 'tool')
  tool_call_id?: string
  name?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDef = any

function getKey(): string {
  const stored = getAppState(KEY_SETTING)
  return stored ? decryptSecret(stored) : ''
}

function getModel(): string {
  return getAppState(MODEL_SETTING) || DEFAULT_MODEL
}

export function registerSwarmAgentHandlers(_getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('swarmAgent:hasKey', () => Boolean(getKey()))

  ipcMain.handle('swarmAgent:setKey', (_e, key: string) => {
    setAppState(KEY_SETTING, key ? encryptSecret(key) : '')
    return true
  })

  // Run one model turn. Streams assistant text deltas to the renderer via
  // `swarmagent:delta` (keyed by requestId) and resolves with the assembled
  // assistant message so the renderer can execute any tool calls and loop.
  ipcMain.handle('swarmAgent:chat', async (_e, requestId: string, messages: ChatMessage[], tools: ToolDef[]) => {
    const apiKey = getKey()
    if (!apiKey) return { error: 'no-key' }

    // Stream deltas back to the window that asked — the main window OR the
    // desktop widget, whichever invoked this turn. (getWindow stays available
    // for any main-window-specific needs, but streaming must follow the caller.)
    const sender = _e.sender
    const client = new Groq({ apiKey })

    try {
      const stream = await client.chat.completions.create({
        model: getModel(),
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] as never,
        tools: tools && tools.length ? tools : undefined,
        tool_choice: tools && tools.length ? 'auto' : undefined,
        stream: true,
      })

      let content = ''
      // Tool calls arrive as incremental fragments keyed by index; accumulate
      // the function name + arguments string and only parse on the renderer side.
      const toolCalls: Record<number, { id: string; name: string; args: string }> = {}

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) {
          content += delta.content
          if (!sender.isDestroyed()) sender.send('swarmagent:delta', { requestId, text: delta.content })
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const slot = (toolCalls[idx] ??= { id: '', name: '', args: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
        }
      }

      const assembledCalls = Object.values(toolCalls)
        .filter(c => c.name)
        .map(c => ({ id: c.id || `call_${c.name}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } }))

      const message: ChatMessage = {
        role: 'assistant',
        content: content || null,
        ...(assembledCalls.length ? { tool_calls: assembledCalls } : {}),
      }
      return { message }
    } catch (err) {
      const e = err as { status?: number; message?: string }
      // Surface a readable, assistant-visible reason rather than crashing.
      let msg = e.message || String(err)
      if (e.status === 401) msg = 'Invalid Groq API key. Check Settings → SwarmAgent.'
      else if (e.status === 429) msg = 'Groq rate limit reached. Try again in a moment.'
      else if (e.status === 404) msg = `Model "${getModel()}" not found on Groq. Pick another in Settings → SwarmAgent.`
      return { error: msg }
    }
  })
}
