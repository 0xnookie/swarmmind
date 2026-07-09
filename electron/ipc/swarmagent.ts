import { ipcMain, BrowserWindow } from 'electron'
import Groq from 'groq-sdk'
import { getAppState, setAppState } from '../../memory/queries'
import { encryptSecret, decryptSecret } from '../secrets'
import { stripCodeFences, extractJsonObject } from '../lib/aiParse'

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
- Reading the codebase: search_code greps file contents and returns file:line hits (use it for "where is X handled?", "find usages of Y"); read_file returns a workspace file's contents (path relative to the workspace root) so you can answer questions about the code directly; list_files discovers files (optionally filtered). Typical flow: search_code to locate, then read_file the best hit. Use them for "what does X do?", "show me file Y", or to inspect a file the user @-mentioned. Prefer reading the actual file over guessing.
- EDITING the codebase: propose_edits opens your concrete changes in the Composer's review UI (per-file diffs, safety checkpoint, one-click apply). When the user asks you to change/fix/implement something and the edit is within your reach, do it yourself: search_code + read_file to get the exact current contents, then propose_edits with the COMPLETE new content of every touched file. Never paste large code into chat for the user to copy when propose_edits can hand them an applyable diff instead. Nothing is written until the user applies, so you don't need permission to propose. For big or exploratory jobs, delegating to an agent pane (send_to_agent) is still the better tool.
- Tasks: create_task, list_tasks, update_task manage the shared Kanban task queue.
- Shared memory: remember (save a note) and recall (search notes) the workspace's shared memory.
- Orchestration: start_orchestration kicks off the autonomous Conductor (optionally with a goal for the lead pane to decompose); stop_orchestration turns it off. Agent panes must be running first.

A "LIVE APP STATE (right now)" section is appended below on every turn with the open workspace, the agent panes and whether each is idle / working / waiting for input, active loops, and orchestration mode. Trust it for basic awareness — you usually do NOT need get_status to answer "what's running?" or to pick a pane. Still call get_status for task counts, or the read_agent / list_* tools when you need detail it doesn't include. Keep using a tool only when the user actually wants that action; otherwise just talk.

Reply in the user's language (the app supports English and German). Be concise and friendly.`

// Inline edit (Cmd/Ctrl+K in the file editor) — the Cursor-style "vibe coding"
// surface. Unlike the chat assistant this is a single, focused completion: it
// takes a code snippet + an instruction and returns the rewritten snippet only,
// with no prose or fences, so the editor can drop it straight back into the doc.
const EDIT_SYSTEM_PROMPT = `You are an expert pair programmer doing an inline code edit inside an editor, like Cursor's Cmd-K.

You receive: the language, the file name, the code snippet the user has selected (may be empty for a pure insertion), and the lines immediately before/after it for context. You also receive the user's instruction.

Rewrite the SELECTED snippet so it satisfies the instruction. Output ONLY the replacement code — the exact text that should take the place of the selection.

The user may @-mention other files from the project; their contents are provided under "Referenced files" purely as context (e.g. to match a style, reuse a helper, or follow an interface). Use them to inform the edit, but never output their contents — return only the new selection.

Hard rules:
- No explanations, no commentary, no apologies.
- No Markdown code fences (no \`\`\`). Output raw code only.
- Preserve the surrounding indentation and code style. Match the snippet's existing indentation level.
- Do not repeat the before/after context lines or referenced files — they are only there to help you; return just the new selection.
- If the selection is empty, output the new code to insert at the cursor.
- Keep edits minimal and focused on the instruction; don't rewrite unrelated code.`

// AI diagnostics ("Fix with AI" lint) — the model reviews a file and returns
// structured problems (line, severity, message, suggested fix) which the editor
// renders in the CodeMirror lint gutter. Each problem can feed its fix back into
// the Cmd-K inline-edit flow.
const DIAGNOSE_SYSTEM_PROMPT = `You are a precise code reviewer acting as a linter. You receive a source file and must report real problems only.

Return STRICT JSON — no prose, no Markdown, no fences — matching exactly:

{
  "diagnostics": [
    { "line": <1-based line number>, "severity": "error" | "warning" | "info", "message": "<concise description of the problem>", "fix": "<short imperative instruction to fix it>" }
  ]
}

Rules:
- Report genuine issues: bugs, likely runtime errors, type mismatches, unhandled cases, security problems, clear logic mistakes, obviously broken/missing code.
- Do NOT report subjective style preferences, formatting, or nitpicks.
- "line" must be the 1-based line where the problem is. Keep "message" short and specific.
- "fix" is a brief instruction (e.g. "Add a null check before accessing .length"); omit it if no concrete fix applies.
- If there are no real problems, return {"diagnostics": []}.
- Report at most 20 of the most important problems.`

// Multi-file Composer (Cursor's "Composer") — a chat-driven flow that proposes
// coordinated edits across several files at once. The model is given the
// instruction plus the contents of the context files and must return a strict
// JSON plan of file changes (full new content per file), which the renderer
// previews as diffs and applies with the user's consent.
const COMPOSE_SYSTEM_PROMPT = `You are a senior software engineer making a coordinated, multi-file change to a codebase, like Cursor's Composer.

You receive the user's instruction and the current contents of the relevant files. Plan the change and return it as STRICT JSON — no prose, no Markdown, no code fences — matching exactly this shape:

{
  "summary": "one or two sentences describing the change",
  "changes": [
    { "path": "relative/path/from/workspace/root.ext", "action": "edit" | "create", "content": "the COMPLETE new file contents" }
  ]
}

Rules:
- For "edit", "content" must be the ENTIRE updated file, not a diff or a fragment — the app overwrites the file with it.
- For "create", provide the full contents of the new file.
- Only include files you actually change. Do not invent files you weren't shown unless the instruction clearly requires creating them.
- Use workspace-root-relative paths with forward slashes.
- Keep the change focused on the instruction. Preserve unrelated code, imports, and formatting exactly.
- Return valid JSON only. Escape newlines and quotes correctly inside "content".`

// Next-edit prediction ("Tab to jump", Cursor-style) — after an edit is made,
// the model points at the single most likely follow-up location so the editor
// can offer to jump there and continue. Returns a 1-based line + a short
// instruction, or signals there's nothing to do.
const NEXT_EDIT_SYSTEM_PROMPT = `You predict the NEXT edit a developer will want to make, like Cursor's "Tab to jump". You receive a source file (each line prefixed with "<n>\\t") and the line range that was JUST edited.

Identify the single most likely place that now needs a related follow-up edit — e.g. a call site of a renamed/changed symbol, a type or interface to update, an export to add, a now-stale comment, or a matching branch. Prefer somewhere a real, mechanical follow-up is needed because of the change just made.

Return STRICT JSON — no prose, no Markdown, no fences — matching exactly:

{ "line": <1-based line number>, "instruction": "<short imperative describing the follow-up edit>" }

Rules:
- "line" must be a real line in the file and should NOT be inside the range just edited.
- "instruction" is brief and concrete (e.g. "Update the call to pass the new argument").
- If no clear, useful follow-up edit exists, return exactly {"none": true}.`

// Ghost-text autocomplete (Copilot-style) — the model predicts the text to
// insert at the cursor given the code on either side. Kept terse and
// non-streaming for low latency; the renderer shows the result as dimmed ghost
// text that Tab accepts.
const COMPLETE_SYSTEM_PROMPT = `You are a code autocomplete engine, like GitHub Copilot. You receive the code immediately before the cursor (PREFIX) and after the cursor (SUFFIX). Output ONLY the text that should be inserted at the cursor to continue the code naturally.

Hard rules:
- Output raw text only — no explanations, no Markdown fences, no commentary.
- Do NOT repeat any of the prefix or suffix. Output only the new insertion.
- Predict the most likely continuation: usually the rest of the current line, or a short block (a few lines at most).
- Match the surrounding language, style, indentation and naming.
- If the code is already complete at the cursor, output nothing.`

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

  // List the models available to this Groq key, so Settings can offer a live
  // picker instead of a free-text guess (Groq's catalogue changes often). Newest
  // first when a created timestamp is present; empty array on no-key/error so the
  // UI just falls back to free text + the curated recommendations.
  ipcMain.handle('swarmAgent:listModels', async (): Promise<string[]> => {
    const apiKey = getKey()
    if (!apiKey) return []
    try {
      const client = new Groq({ apiKey })
      const res = await client.models.list()
      const data = (res.data ?? []) as { id: string; created?: number }[]
      return data
        .filter(m => m.id && !/whisper|tts|guard|embed/i.test(m.id)) // chat models only
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map(m => m.id)
    } catch {
      return []
    }
  })

  // Run one model turn. Streams assistant text deltas to the renderer via
  // `swarmagent:delta` (keyed by requestId) and resolves with the assembled
  // assistant message so the renderer can execute any tool calls and loop.
  ipcMain.handle('swarmAgent:chat', async (_e, requestId: string, messages: ChatMessage[], tools: ToolDef[], context?: string) => {
    const apiKey = getKey()
    if (!apiKey) return { error: 'no-key' }

    // Ground the model in the live app state (panes, what's running/waiting,
    // loops, orchestration) built fresh by the renderer each turn, so it can
    // answer "what's running?" or pick the right pane without first calling a
    // tool. Appended to the static system prompt as a clearly-labelled section.
    const systemPrompt = context && context.trim()
      ? `${SYSTEM_PROMPT}\n\n--- LIVE APP STATE (right now) ---\n${context.trim()}`
      : SYSTEM_PROMPT

    // Stream deltas back to the window that asked — the main window OR the
    // desktop widget, whichever invoked this turn. (getWindow stays available
    // for any main-window-specific needs, but streaming must follow the caller.)
    const sender = _e.sender
    const client = new Groq({ apiKey })

    try {
      const stream = await client.chat.completions.create({
        model: getModel(),
        messages: [{ role: 'system', content: systemPrompt }, ...messages] as never,
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

  // Inline editor edit (Cmd/Ctrl+K). Streams the rewritten snippet to the
  // calling window via `swarmagent:editDelta` (keyed by requestId) and resolves
  // with the full text. Strips any stray Markdown fences the model adds despite
  // the system prompt, so the editor always gets raw code.
  ipcMain.handle(
    'swarmAgent:editCode',
    async (
      _e,
      requestId: string,
      payload: {
        instruction: string
        selection: string
        before: string
        after: string
        language: string
        fileName: string
        mentions?: { path: string; content: string }[]
      },
    ) => {
      const apiKey = getKey()
      if (!apiKey) return { error: 'no-key' }

      const sender = _e.sender
      const client = new Groq({ apiKey })

      const mentionBlock = (payload.mentions ?? [])
        .filter((m) => m.path && m.content)
        .map((m) => `--- Referenced file: ${m.path} ---\n${m.content}`)
        .join('\n\n')

      const userMsg = [
        `Language: ${payload.language || 'plain text'}`,
        `File: ${payload.fileName || 'untitled'}`,
        '',
        ...(mentionBlock ? [mentionBlock, ''] : []),
        '--- Lines before selection (context, do not repeat) ---',
        payload.before || '(start of file)',
        '--- Selected snippet to rewrite ---',
        payload.selection || '(empty — insert new code here)',
        '--- Lines after selection (context, do not repeat) ---',
        payload.after || '(end of file)',
        '',
        `Instruction: ${payload.instruction}`,
      ].join('\n')

      try {
        const stream = await client.chat.completions.create({
          model: getModel(),
          messages: [
            { role: 'system', content: EDIT_SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ] as never,
          stream: true,
        })

        let raw = ''
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta
          if (delta?.content) {
            raw += delta.content
            if (!sender.isDestroyed())
              sender.send('swarmagent:editDelta', { requestId, text: delta.content })
          }
        }

        // Defensive fence strip: some models wrap output in ```lang … ``` despite
        // the instruction.
        return { code: stripCodeFences(raw) }
      } catch (err) {
        const e = err as { status?: number; message?: string }
        let msg = e.message || String(err)
        if (e.status === 401) msg = 'Invalid Groq API key. Check Settings → SwarmAgent.'
        else if (e.status === 429) msg = 'Groq rate limit reached. Try again in a moment.'
        else if (e.status === 404)
          msg = `Model "${getModel()}" not found on Groq. Pick another in Settings → SwarmAgent.`
        return { error: msg }
      }
    },
  )

  // Ghost-text autocomplete. Non-streaming, short, best-effort: returns the
  // predicted insertion at the cursor (capped), or empty text. Errors resolve
  // to empty text rather than rejecting — a failed completion should be silent.
  ipcMain.handle(
    'swarmAgent:complete',
    async (
      _e,
      payload: { prefix: string; suffix: string; language: string },
    ): Promise<{ text: string }> => {
      const apiKey = getKey()
      if (!apiKey) return { text: '' }
      try {
        const client = new Groq({ apiKey })
        const res = await client.chat.completions.create({
          model: getModel(),
          messages: [
            { role: 'system', content: COMPLETE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Language: ${payload.language || 'plain text'}\n\nPREFIX:\n${payload.prefix}\n\nSUFFIX:\n${payload.suffix}`,
            },
          ] as never,
          stream: false,
          max_tokens: 160,
          temperature: 0.1,
        })
        // Strip a stray code fence if the model added one despite instructions.
        let text = stripCodeFences(res.choices[0]?.message?.content ?? '')
        // Cap the insertion so a runaway completion can't dump a whole file.
        if (text.length > 400) text = text.slice(0, 400)
        return { text }
      } catch {
        return { text: '' }
      }
    },
  )

  // Multi-file Composer. Returns a parsed change plan or an error. Non-streaming
  // — the plan can be large, and the renderer needs the whole JSON to diff it.
  ipcMain.handle(
    'swarmAgent:compose',
    async (
      _e,
      payload: { instruction: string; files: { path: string; content: string }[] },
    ): Promise<{ summary?: string; changes?: { path: string; action: string; content: string }[]; error?: string }> => {
      const apiKey = getKey()
      if (!apiKey) return { error: 'no-key' }

      const fileBlock = (payload.files ?? [])
        .filter((f) => f.path)
        .map((f) => `--- File: ${f.path} ---\n${f.content}`)
        .join('\n\n')

      const userMsg = [
        fileBlock ? `Current files:\n\n${fileBlock}` : 'No files were provided as context.',
        '',
        `Instruction: ${payload.instruction}`,
      ].join('\n')

      try {
        const client = new Groq({ apiKey })
        const res = await client.chat.completions.create({
          model: getModel(),
          messages: [
            { role: 'system', content: COMPOSE_SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ] as never,
          stream: false,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        })
        const raw = res.choices[0]?.message?.content ?? ''
        // Be tolerant: strip fences and pull the outermost JSON object if the
        // model wrapped it despite json_object mode.
        const jsonText = extractJsonObject(raw)

        let parsed: { summary?: string; changes?: { path: string; action?: string; content?: string }[] }
        try {
          parsed = JSON.parse(jsonText)
        } catch {
          return { error: 'The model did not return a valid change plan. Try rephrasing the request.' }
        }
        const changes = (parsed.changes ?? [])
          .filter((c) => c && typeof c.path === 'string' && typeof c.content === 'string')
          .map((c) => ({
            path: c.path.replace(/\\/g, '/'),
            action: c.action === 'create' ? 'create' : 'edit',
            content: c.content as string,
          }))
        if (!changes.length) return { error: 'The model proposed no file changes.' }
        return { summary: parsed.summary ?? '', changes }
      } catch (err) {
        const e = err as { status?: number; message?: string }
        let msg = e.message || String(err)
        if (e.status === 401) msg = 'Invalid Groq API key. Check Settings → SwarmAgent.'
        else if (e.status === 429) msg = 'Groq rate limit reached. Try again in a moment.'
        else if (e.status === 404)
          msg = `Model "${getModel()}" not found on Groq. Pick another in Settings → SwarmAgent.`
        return { error: msg }
      }
    },
  )

  // AI diagnostics. Returns structured problems for a single file, or an error.
  ipcMain.handle(
    'swarmAgent:diagnose',
    async (
      _e,
      payload: { content: string; language: string; fileName: string },
    ): Promise<{ diagnostics?: { line: number; severity: string; message: string; fix?: string }[]; error?: string }> => {
      const apiKey = getKey()
      if (!apiKey) return { error: 'no-key' }
      // Number the lines so the model can reference them reliably.
      const numbered = payload.content
        .split('\n')
        .map((l, i) => `${i + 1}\t${l}`)
        .join('\n')
        .slice(0, 24000)
      try {
        const client = new Groq({ apiKey })
        const res = await client.chat.completions.create({
          model: getModel(),
          messages: [
            { role: 'system', content: DIAGNOSE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Language: ${payload.language || 'plain text'}\nFile: ${payload.fileName || 'untitled'}\n\nSource (each line prefixed with "<n>\\t"):\n${numbered}`,
            },
          ] as never,
          stream: false,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        })
        const jsonText = extractJsonObject(res.choices[0]?.message?.content ?? '')
        let parsed: { diagnostics?: { line?: number; severity?: string; message?: string; fix?: string }[] }
        try {
          parsed = JSON.parse(jsonText)
        } catch {
          return { error: 'The model did not return valid diagnostics.' }
        }
        const diagnostics = (parsed.diagnostics ?? [])
          .filter((d) => d && typeof d.line === 'number' && typeof d.message === 'string')
          .map((d) => ({
            line: Math.max(1, Math.floor(d.line as number)),
            severity: d.severity === 'error' || d.severity === 'info' ? d.severity : 'warning',
            message: d.message as string,
            ...(typeof d.fix === 'string' && d.fix ? { fix: d.fix } : {}),
          }))
          .slice(0, 20)
        return { diagnostics }
      } catch (err) {
        const e = err as { status?: number; message?: string }
        let msg = e.message || String(err)
        if (e.status === 401) msg = 'Invalid Groq API key. Check Settings → SwarmAgent.'
        else if (e.status === 429) msg = 'Groq rate limit reached. Try again in a moment.'
        else if (e.status === 404)
          msg = `Model "${getModel()}" not found on Groq. Pick another in Settings → SwarmAgent.`
        return { error: msg }
      }
    },
  )

  // Next-edit prediction. Returns the raw, validated-enough prediction
  // ({line,instruction} or {none:true}); the renderer clamps it against the live
  // document via resolveNextEditTarget. Best-effort: a no-key/parse failure
  // resolves to {none:true} so the feature simply stays quiet.
  ipcMain.handle(
    'swarmAgent:nextEdit',
    async (
      _e,
      payload: { content: string; language: string; fileName: string; editedFromLine: number; editedToLine: number },
    ): Promise<{ prediction?: { line?: number; instruction?: string; none?: boolean }; error?: string }> => {
      const apiKey = getKey()
      if (!apiKey) return { prediction: { none: true } }
      const numbered = payload.content
        .split('\n')
        .map((l, i) => `${i + 1}\t${l}`)
        .join('\n')
        .slice(0, 24000)
      try {
        const client = new Groq({ apiKey })
        const res = await client.chat.completions.create({
          model: getModel(),
          messages: [
            { role: 'system', content: NEXT_EDIT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Language: ${payload.language || 'plain text'}\nFile: ${payload.fileName || 'untitled'}\nJust edited lines ${payload.editedFromLine}–${payload.editedToLine}.\n\nSource:\n${numbered}`,
            },
          ] as never,
          stream: false,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        })
        const jsonText = extractJsonObject(res.choices[0]?.message?.content ?? '')
        try {
          const parsed = JSON.parse(jsonText) as { line?: number; instruction?: string; none?: boolean }
          return { prediction: parsed }
        } catch {
          return { prediction: { none: true } }
        }
      } catch (err) {
        const e = err as { status?: number; message?: string }
        let msg = e.message || String(err)
        if (e.status === 401) msg = 'Invalid Groq API key. Check Settings → SwarmAgent.'
        else if (e.status === 429) msg = 'Groq rate limit reached. Try again in a moment.'
        else if (e.status === 404)
          msg = `Model "${getModel()}" not found on Groq. Pick another in Settings → SwarmAgent.`
        return { error: msg }
      }
    },
  )
}
