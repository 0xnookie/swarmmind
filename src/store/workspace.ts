import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Language } from '../i18n'
import type { VoiceModel } from '../hooks/useVoice'
import { addSnippet as addSnippetTo, removeSnippet as removeSnippetFrom, type Snippet } from '../lib/snippets'
import {
  applyAppearance,
  clampEditorFontSize,
  DEFAULT_APPEARANCE,
  type ThemePreset,
  type UiDensity,
  type UiFontId,
  type MonoFontId,
  type AppearanceSettings,
} from '../appearance'

// The single source of truth for agent ids. The AgentId type is *derived* from
// this array, so the runtime list and the type can't drift; renderer consumers
// (swarmagent tools, the timeline) import AGENT_IDS instead of re-declaring it.
// Keep in sync with the node-side copy in memory/queries.ts.
export const AGENT_IDS = ['claude', 'codex', 'cursor', 'windsurf', 'kilo', 'opencode', 'cline'] as const
export type AgentId = (typeof AGENT_IDS)[number]
export type PtyStatus = 'idle' | 'running' | 'exited' | 'error'
export type ShellStyle = 'powershell' | 'cmd' | 'bash'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  agentId: AgentId | null
  ptyStatus: PtyStatus
  taskId?: string | null
  cwd?: string | null
  pendingAutoSpawn?: boolean
  // Persisted: a coding agent (not a bare shell) was live here when the layout
  // was last saved. Drives session resume on the next workspace open.
  agentRunning?: boolean
  // Persisted: the agent's conversation/session id for this pane. We assign it
  // when spawning fresh (e.g. `claude --session-id <id>`) so we can later resume
  // exactly this pane's session (`claude --resume <id>`), keeping each pane's
  // conversation distinct.
  sessionId?: string
  // Transient (set only while loading a saved layout): the pending auto-spawn
  // should resume the agent's prior conversation rather than start fresh.
  resume?: boolean
  // Phase 6 — user-customised pane label and accent colour (persisted).
  title?: string
  color?: string
  // Git worktree isolation (opt-in, persisted). When `worktree` is true, the
  // agent spawns inside a dedicated git worktree/branch instead of the workspace
  // root; `worktreePath`/`worktreeBranch` are filled in once it's materialised
  // and reused on resume. See electron/git-manager.ts.
  worktree?: boolean
  worktreePath?: string | null
  worktreeBranch?: string | null
  // User-chosen worktree name (persisted). When set, it's used as the branch
  // hint at creation time instead of the pane title; the branch becomes
  // `swarmmind/<sanitized name>`. Empty/undefined falls back to title → agent →
  // pane id. Only affects a worktree that hasn't been materialised yet.
  worktreeName?: string
  // Mixed workspace (persisted): the workspace this pane's agent belongs to,
  // when it differs from the currently-open (host) workspace. Undefined = the
  // host workspace (the default). A foreign pane spawns with this workspace's
  // root as cwd and routes its MCP memory/tasks/events to this workspace's DB,
  // so an agent of workspace B can run inside workspace A's window. See
  // electron/ipc/pty.ts and the per-agent MCP routing in memory/db.ts.
  workspaceId?: string
}

export interface PaneGroup {
  type: 'group'
  id: string
  direction: 'horizontal' | 'vertical'
  children: PaneNode[]
  sizes?: number[]
}

export type PaneNode = PaneLeaf | PaneGroup

// A discrete "agent needs you" event, surfaced in the TopBar notification
// center. Mirrors the OS notification fired in pty-manager when a pane goes
// quiet. Session-only (not persisted), like paneAttention.
export interface AppNotification {
  id: string
  paneId: string
  agentId: AgentId | null
  // Snapshot of the pane's custom title (if any) at notify time, so the entry
  // still reads sensibly even if the pane is later renamed or closed.
  paneTitle?: string
  timestamp: number
  read: boolean
}

export interface WorkspaceInfo {
  id: string
  name: string
  rootPath: string
}

// An open tab in the code editor (FilePanel). Lifted into the store so unsaved
// edits survive toggling the editor away and back (the panel unmounts otherwise).
// Session-only; cleared on a workspace switch since the paths are workspace-local.
export interface EditorTab {
  path: string
  name: string
  content: string
  dirty: boolean
  // Image tabs carry decoded data instead of editable text.
  image?: ImageData
}

export type LeftPanelTab = 'tasks' | 'skills'

// ── Orchestration (Conductor + Lead) ───────────────────────────────────────────
// off      → conductor inactive (purely manual coordination)
// assisted → conductor proposes each dispatch; user approves
// auto     → conductor dispatches automatically
export type OrchestrationMode = 'off' | 'assisted' | 'auto'

// A goal-driven run moves through these phases. Plain task-queue dispatch (no
// lead/goal) stays in 'idle' the whole time — only goal-driven runs synthesize.
export type OrchestratorPhase = 'idle' | 'running' | 'synthesizing' | 'done'

// A pending dispatch awaiting user approval in 'assisted' mode. Carries the
// fully-prepared prompt so approval is a pure "inject this" action.
export interface DispatchProposal {
  paneId: string
  taskId: string
  title: string
  agentId: AgentId | null
  prompt: string
}

export interface OrchestratorLogEntry {
  id: string
  ts: number
  text: string
}

// ── Loops (recurring prompt schedules) ──────────────────────────────────────
// A "loop" is a saved schedule that re-injects a prompt into an agent pane on a
// fixed interval — SwarmMind's take on Claude Code's `/loop`. The runner lives
// in hooks/useLoops.ts; loops are persisted per-workspace (app setting
// `loops:<workspaceId>`) so they survive a restart.
export interface SwarmLoop {
  id: string
  // The schedule's display name and a short description of what it does.
  name: string
  description: string
  // The prompt/command injected into the target pane(s) on each run.
  prompt: string
  // How often it runs, in seconds.
  intervalSec: number
  // Target pane id, or null = every running agent pane (broadcast).
  paneId: string | null
  // Snapshot of the target pane's agent at create time, for display.
  agentId: AgentId | null
  // Running (true) or paused (false).
  enabled: boolean
  runCount: number
  lastRunAt: number | null
  // Epoch ms of the next scheduled run. The runner fires once now >= this.
  nextRunAt: number | null
  createdAt: number
}

// The fields a caller supplies when creating a loop; the rest are derived.
export type LoopInput = Pick<SwarmLoop, 'name' | 'description' | 'prompt' | 'intervalSec' | 'paneId' | 'agentId'> & {
  enabled?: boolean
}

// A loop SwarmMind *detected* running inside a pane's CLI (e.g. a Claude Code
// `/loop`), as opposed to one it manages itself. Read-only — SwarmMind can't
// control the CLI's scheduler, so these are display-only and session-scoped.
export interface CliLoop {
  id: string
  paneId: string
  // The command being looped (the text after `/loop <interval>`), or the raw line.
  command: string
  // Parsed interval token (e.g. "5m"), or null when the loop is self-paced.
  interval: string | null
  detectedAt: number
}

interface WorkspaceState {
  workspace: WorkspaceInfo | null
  rootPane: PaneGroup
  kanbanOpen: boolean
  leftPanelTab: LeftPanelTab
  memoryPanelOpen: boolean
  previewPanelOpen: boolean
  previewUrl: string
  setupModalOpen: boolean
  filePanelOpen: boolean
  settingsOpen: boolean
  settingsAgentId: AgentId | null
  activeTaskId: string | null
  shellStyle: ShellStyle
  defaultAgentId: AgentId | null
  terminalFontSize: number
  terminalCursorBlink: boolean
  closeToTray: boolean
  // UI display language (persisted as the `language` app setting).
  language: Language
  // ── SwarmVoice (persisted as `voiceModel` / `voicePreload` app settings) ──
  // Which Whisper model to transcribe with, and whether to download/warm it in
  // the background shortly after launch.
  voiceModel: VoiceModel
  voicePreload: boolean
  // ── Appearance (applied live via CSS variables, persisted) ────────────────
  themePreset: ThemePreset
  accentColor: string | null
  uiDensity: UiDensity
  uiFont: UiFontId
  monoFont: MonoFontId
  editorFontSize: number
  // AI ghost-text autocomplete in the file editor (Copilot-style). Off by
  // default since it spends model tokens on every pause in typing.
  ghostTextEnabled: boolean
  // Reusable code snippets saved from the editor (persisted globally as the
  // `editorSnippets` JSON app-setting).
  snippets: Snippet[]
  // Bumped on any appearance change so the terminal can re-read CSS colours.
  appearanceVersion: number
  // ── Keyboard shortcuts: actionId → canonical combo overrides ──────────────
  keybindings: Record<string, string>
  activePaneId: string | null
  // Phase 1 — pane messaging: panes selected as broadcast/pipe targets, and
  // whether the broadcast input bar is visible.
  selectedPaneIds: string[]
  broadcastBarOpen: boolean
  // Phase 2 — agent activity: 'working' while output streams, 'waiting' once an
  // agent has gone quiet (finished a turn / awaiting input). Keyed by paneId.
  paneAttention: Record<string, 'working' | 'waiting'>
  // Notification center: discrete "agent is waiting for input" events, newest
  // first. The TopBar bell badge counts the unread ones.
  notifications: AppNotification[]
  // Phase 5 — command palette visibility.
  commandPaletteOpen: boolean
  // Center-area overlays (mutually exclusive): Kanban board, memory graph, the
  // worktree review (per-pane git branch diff + merge), and the swarm timeline.
  boardOpen: boolean
  graphOpen: boolean
  reviewOpen: boolean
  composerOpen: boolean
  // One-shot prefill for the Composer (e.g. from the editor's "Rename across
  // files"): an instruction + context file paths the panel consumes on open.
  // An optional pre-built `plan` lets a caller (e.g. one-click apply from a chat
  // reply) hand the Composer the exact changes so it shows the diff/apply UI
  // directly, skipping the model round-trip.
  composerSeed: {
    instruction: string
    contextPaths: string[]
    plan?: { summary?: string; changes: { path: string; action: string; content: string }[] }
  } | null
  timelineOpen: boolean
  changesOpen: boolean
  checkpointsOpen: boolean
  benchmarksOpen: boolean
  swarmAgentOpen: boolean
  // Paths currently flagged as contended (≥2 active agents touched them recently),
  // driving the Changes-button warning dot. Cleared when the panel is opened.
  contendedPaths: string[]
  // Cost meter: latest cumulative spend per pane (USD + tokens), parsed from
  // agent output and pushed via the `cost` swarm event. Workspace total is the
  // sum across panes. Session-only — the authoritative log lives in `events`.
  paneCost: Record<string, { usd: number; tokens: number }>
  // ── Orchestration (Conductor + Lead) ──────────────────────────────────────
  orchestratorBarOpen: boolean
  orchestrationMode: OrchestrationMode
  // The pane designated as the lead/orchestrator agent (decomposes the goal and
  // synthesises results). Null = pure task-queue dispatch with no lead.
  leadPaneId: string | null
  orchestratorGoal: string
  orchestratorPhase: OrchestratorPhase
  // paneId → the task id currently dispatched to that worker pane.
  paneTask: Record<string, string>
  // In 'assisted' mode, the next dispatch awaiting the user's approval.
  orchestratorProposal: DispatchProposal | null
  // Newest-first activity log shown in the OrchestratorBar (session-only).
  orchestratorLog: OrchestratorLogEntry[]
  // ── Loops ──────────────────────────────────────────────────────────────────
  // Recurring prompt schedules for the current workspace, and the Loops overlay.
  loops: SwarmLoop[]
  loopsOpen: boolean
  // Loops detected running inside panes' CLIs (e.g. Claude Code `/loop`).
  // Session-only and read-only — SwarmMind can only display, not control them.
  cliLoops: CliLoop[]
  // ── Code editor (FilePanel) ──────────────────────────────────────────────────
  // Open editor tabs + the active one, lifted out of FilePanel so unsaved edits
  // survive toggling the editor away (the panel unmounts when another view opens).
  editorTabs: EditorTab[]
  activeEditorPath: string | null

  setWorkspace: (ws: WorkspaceInfo | null) => void
  setEditorTabs: (tabs: EditorTab[]) => void
  setActiveEditorPath: (path: string | null) => void
  setLayout: (root: PaneGroup) => void
  setPtyStatus: (paneId: string, status: PtyStatus) => void
  setAgentId: (paneId: string, agentId: AgentId | null) => void
  setTaskId: (paneId: string, taskId: string | null) => void
  setPaneCwd: (paneId: string, cwd: string | null) => void
  setPaneWorkspace: (paneId: string, workspaceId: string | null) => void
  setAgentRunning: (paneId: string, running: boolean) => void
  setSessionId: (paneId: string, sessionId: string) => void
  setPaneTitle: (paneId: string, title: string) => void
  setPaneColor: (paneId: string, color: string | null) => void
  setPaneWorktree: (paneId: string, enabled: boolean) => void
  setPaneWorktreeName: (paneId: string, name: string | null) => void
  setPaneWorktreeInfo: (paneId: string, info: { path: string; branch: string } | null) => void
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void
  addPane: (agentId?: AgentId, taskId?: string) => void
  closePane: (paneId: string) => void
  clearPendingAutoSpawn: (paneId: string) => void
  toggleKanban: () => void
  setLeftPanelTab: (tab: LeftPanelTab) => void
  toggleMemoryPanel: () => void
  togglePreviewPanel: () => void
  setPreviewUrl: (url: string) => void
  openSetupModal: () => void
  closeSetupModal: () => void
  toggleFilePanel: () => void
  openSettings: (agentId?: AgentId) => void
  closeSettings: () => void
  setActiveTask: (id: string | null) => void
  setShellStyle: (s: ShellStyle) => void
  setDefaultAgentId: (id: AgentId | null) => void
  setTerminalFontSize: (n: number) => void
  setTerminalCursorBlink: (b: boolean) => void
  setCloseToTray: (b: boolean) => void
  setLanguage: (lang: Language) => void
  setVoiceModel: (m: VoiceModel) => void
  setVoicePreload: (b: boolean) => void
  // Appearance setters — each persists and re-applies immediately.
  setThemePreset: (p: ThemePreset) => void
  setAccentColor: (hex: string | null) => void
  setUiDensity: (d: UiDensity) => void
  setUiFont: (f: UiFontId) => void
  setMonoFont: (f: MonoFontId) => void
  setEditorFontSize: (n: number) => void
  setGhostTextEnabled: (b: boolean) => void
  addSnippet: (name: string, body: string, lang?: string) => void
  removeSnippet: (id: string) => void
  hydrateAppearance: (a: Partial<AppearanceSettings>) => void
  // Keybindings — persisted as a JSON override map.
  setKeybinding: (id: string, keys: string) => void
  resetKeybinding: (id: string) => void
  hydrateKeybindings: (map: Record<string, string>) => void
  setActivePaneId: (id: string | null) => void
  togglePaneSelected: (paneId: string) => void
  clearPaneSelection: () => void
  toggleBroadcastBar: () => void
  getLeafIds: () => string[]
  setPaneAttention: (paneId: string, state: 'working' | 'waiting' | null) => void
  addPaneNotification: (paneId: string) => void
  markNotificationRead: (id: string) => void
  markPaneNotificationsRead: (paneId: string) => void
  markAllNotificationsRead: () => void
  deleteNotification: (id: string) => void
  clearNotifications: () => void
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleBoard: () => void
  toggleComposer: () => void
  openComposerWith: (seed: {
    instruction: string
    contextPaths: string[]
    plan?: { summary?: string; changes: { path: string; action: string; content: string }[] }
  }) => void
  clearComposerSeed: () => void
  toggleGraph: () => void
  toggleReview: () => void
  toggleTimeline: () => void
  toggleChanges: () => void
  toggleCheckpoints: () => void
  toggleBenchmarks: () => void
  toggleSwarmAgent: () => void
  addContendedPath: (path: string) => void
  updatePaneCost: (paneId: string, usd: number, tokens: number) => void
  showTerminals: () => void
  // ── Orchestration actions ─────────────────────────────────────────────────
  toggleOrchestratorBar: () => void
  setOrchestrationMode: (mode: OrchestrationMode) => void
  setLeadPaneId: (id: string | null) => void
  setOrchestratorGoal: (goal: string) => void
  setOrchestratorPhase: (phase: OrchestratorPhase) => void
  setPaneTask: (paneId: string, taskId: string | null) => void
  setOrchestratorProposal: (p: DispatchProposal | null) => void
  pushOrchestratorLog: (text: string) => void
  clearOrchestratorLog: () => void
  startOrchestration: () => void
  stopOrchestration: () => void
  // ── Loop actions ───────────────────────────────────────────────────────────
  toggleLoops: () => void
  addLoop: (input: LoopInput) => SwarmLoop
  updateLoop: (id: string, patch: Partial<LoopInput>) => void
  removeLoop: (id: string) => void
  setLoopEnabled: (id: string, enabled: boolean) => void
  markLoopRun: (id: string, at: number) => void
  deferLoop: (id: string, at: number) => void
  setLoops: (loops: SwarmLoop[]) => void
  addCliLoop: (paneId: string, command: string, interval: string | null) => void
  removeCliLoop: (id: string) => void
  clearPaneCliLoops: (paneId: string) => void
  loadFromJson: (json: string) => void
  swapPanes: (idA: string, idB: string) => void
  resetLayout: () => void
  toJson: () => string
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

function newLeaf(agentId: AgentId | null = null, taskId?: string): PaneLeaf {
  return { type: 'leaf', id: uuidv4(), agentId, ptyStatus: 'idle', taskId: taskId ?? null }
}

function findParent(root: PaneGroup, targetId: string): { parent: PaneGroup; index: number } | null {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]
    if (child.id === targetId) return { parent: root, index: i }
    if (child.type === 'group') {
      const found = findParent(child, targetId)
      if (found) return found
    }
  }
  return null
}

function updateLeaf(node: PaneNode, id: string, updater: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') return node.id === id ? updater(node) : node
  return { ...node, children: node.children.map(c => updateLeaf(c, id, updater)) }
}

function pruneGroup(node: PaneNode): PaneNode {
  if (node.type === 'leaf') return node
  const pruned = { ...node, children: node.children.map(pruneGroup) }
  if (pruned.children.length === 0) return newLeaf()
  if (pruned.children.length === 1) return pruned.children[0]
  return pruned
}

function makeRoot(node: PaneNode): PaneGroup {
  if (node.type === 'group') return node
  return { type: 'group', id: uuidv4(), direction: 'horizontal', children: [node] }
}

function replaceNode(root: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (root.id === targetId) return replacement
  if (root.type === 'leaf') return root
  return { ...root, children: root.children.map(c => replaceNode(c, targetId, replacement)) }
}

function findLeafById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const c of node.children) { const f = findLeafById(c, id); if (f) return f }
  return null
}

function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0)
}

function sanitizeLoadedLayout(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    // A coding agent was running in this pane when the app last closed → queue
    // an auto-spawn that resumes its prior conversation. Preserve agentId and
    // the per-pane cwd so resume targets the same session/directory.
    if (node.agentRunning && node.agentId) {
      return { ...node, ptyStatus: 'idle', taskId: null, pendingAutoSpawn: true, resume: true }
    }
    return { ...node, ptyStatus: 'idle', cwd: null, taskId: null, pendingAutoSpawn: false, agentRunning: false, resume: false, sessionId: undefined }
  }
  return { ...node, children: node.children.map(sanitizeLoadedLayout) }
}

function saveLayout(json: string): void {
  window.swarmmind.layoutSave(json).catch(() => {})
}

// Re-apply the current appearance to the document root and bump the version so
// appearance-dependent consumers (the terminal) re-sync.
function reapplyAppearance(
  get: () => WorkspaceState,
  set: (fn: (s: WorkspaceState) => Partial<WorkspaceState>) => void,
): void {
  const s = get()
  applyAppearance({
    themePreset: s.themePreset,
    accentColor: s.accentColor,
    uiDensity: s.uiDensity,
    uiFont: s.uiFont,
    monoFont: s.monoFont,
    editorFontSize: s.editorFontSize,
  })
  set(st => ({ appearanceVersion: st.appearanceVersion + 1 }))
}

export function buildLayoutForCount(count: number, defaultAgentId: AgentId | null): PaneGroup {
  const leaf = (): PaneLeaf => {
    const l: PaneLeaf = { type: 'leaf', id: uuidv4(), agentId: defaultAgentId, ptyStatus: 'idle', taskId: null }
    if (defaultAgentId) l.pendingAutoSpawn = true
    return l
  }
  if (count <= 1) return { type: 'group', id: uuidv4(), direction: 'horizontal', children: [leaf()] }
  const rowsPerCol = Math.ceil(count / 2)
  const columns: PaneNode[] = []
  let placed = 0
  for (let c = 0; c < 2 && placed < count; c++) {
    const rows = Math.min(rowsPerCol, count - placed)
    const children: PaneLeaf[] = Array.from({ length: rows }, leaf)
    placed += rows
    columns.push(
      children.length === 1
        ? children[0]
        : { type: 'group', id: uuidv4(), direction: 'vertical', children }
    )
  }
  return { type: 'group', id: uuidv4(), direction: 'horizontal', children: columns }
}

// ── Store ─────────────────────────────────────────────────────────────────────

// The center-area overlays are mutually exclusive — opening one closes the rest.
// Spread this into each toggle so adding an overlay is a one-line change here
// instead of editing every other toggle's close-list.
const ALL_OVERLAYS_CLOSED = {
  boardOpen: false,
  graphOpen: false,
  filePanelOpen: false,
  reviewOpen: false,
  composerOpen: false,
  timelineOpen: false,
  changesOpen: false,
  checkpointsOpen: false,
  benchmarksOpen: false,
  swarmAgentOpen: false,
  loopsOpen: false,
} as const

// The terminal pane grid (CenterArea) is shown only when a workspace is open and
// every center overlay is closed. Broadcast/Orchestrator act on the panes, so
// their controls are only meaningful here — gate them on this single source of
// truth rather than re-deriving the overlay list in each consumer.
export function selectTerminalsVisible(
  s: { workspace: unknown } & Record<keyof typeof ALL_OVERLAYS_CLOSED, boolean>,
): boolean {
  if (!s.workspace) return false
  return (Object.keys(ALL_OVERLAYS_CLOSED) as (keyof typeof ALL_OVERLAYS_CLOSED)[])
    .every(k => !s[k])
}

const initialRoot: PaneGroup = {
  type: 'group',
  id: uuidv4(),
  direction: 'horizontal',
  children: [newLeaf()]
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspace: null,
  rootPane: initialRoot,
  kanbanOpen: true,
  leftPanelTab: 'tasks',
  memoryPanelOpen: false,
  previewPanelOpen: false,
  previewUrl: 'http://localhost:3000',
  setupModalOpen: false,
  filePanelOpen: false,
  settingsOpen: false,
  settingsAgentId: null,
  activeTaskId: null,
  shellStyle: 'powershell',
  defaultAgentId: null,
  terminalFontSize: 13,
  terminalCursorBlink: true,
  closeToTray: true,
  language: 'en',
  voiceModel: 'base',
  voicePreload: true,
  themePreset: DEFAULT_APPEARANCE.themePreset,
  accentColor: DEFAULT_APPEARANCE.accentColor,
  uiDensity: DEFAULT_APPEARANCE.uiDensity,
  uiFont: DEFAULT_APPEARANCE.uiFont,
  monoFont: DEFAULT_APPEARANCE.monoFont,
  editorFontSize: DEFAULT_APPEARANCE.editorFontSize,
  ghostTextEnabled: false,
  snippets: [],
  appearanceVersion: 0,
  keybindings: {},
  activePaneId: null,
  selectedPaneIds: [],
  broadcastBarOpen: false,
  paneAttention: {},
  notifications: [],
  commandPaletteOpen: false,
  boardOpen: false,
  graphOpen: false,
  reviewOpen: false,
  composerOpen: false,
  composerSeed: null,
  timelineOpen: false,
  changesOpen: false,
  checkpointsOpen: false,
  benchmarksOpen: false,
  swarmAgentOpen: false,
  contendedPaths: [],
  paneCost: {},
  orchestratorBarOpen: false,
  orchestrationMode: 'off',
  leadPaneId: null,
  orchestratorGoal: '',
  orchestratorPhase: 'idle',
  paneTask: {},
  orchestratorProposal: null,
  orchestratorLog: [],
  loops: [],
  loopsOpen: false,
  cliLoops: [],
  editorTabs: [],
  activeEditorPath: null,

  setWorkspace: (ws) => set(s => {
    // On an actual switch (not a rename of the current workspace), clear the
    // cost/contention display state — it's scoped to the previous workspace's
    // panes and would otherwise leak into the new one (e.g. the TopBar cost pill
    // summing a different workspace's spend). Guarded on id change so renaming the
    // active workspace (setWorkspace with the same id) doesn't wipe live totals.
    if (ws?.id === s.workspace?.id) return { workspace: ws }
    // Editor tabs hold paths from the previous workspace — drop them on a switch.
    return { workspace: ws, paneCost: {}, contendedPaths: [], cliLoops: [], editorTabs: [], activeEditorPath: null }
  }),

  setEditorTabs: (tabs) => set({ editorTabs: tabs }),
  setActiveEditorPath: (path) => set({ activeEditorPath: path }),

  setLayout: (root) => {
    set({ rootPane: root })
    saveLayout(JSON.stringify(root))
  },

  setPtyStatus: (paneId, status) =>
    set(s => ({ rootPane: makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, ptyStatus: status }))) })),

  setAgentId: (paneId, agentId) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, agentId })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  setTaskId: (paneId, taskId) =>
    set(s => ({ rootPane: makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, taskId }))) })),

  setPaneCwd: (paneId, cwd) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, cwd })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  // Bind a pane to a (foreign) workspace for the mixed-workspace feature. null
  // clears the binding (pane reverts to the host workspace). Also clears any
  // per-pane cwd so the next spawn resolves the new workspace's root; the UI
  // only allows this while the pane's agent isn't running.
  setPaneWorkspace: (paneId, workspaceId) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({
        ...l,
        workspaceId: workspaceId ?? undefined,
        cwd: null,
      })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  // Persist whether a coding agent is live in this pane so the session can be
  // resumed on the next workspace open.
  setAgentRunning: (paneId, running) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, agentRunning: running })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  setSessionId: (paneId, sessionId) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, sessionId })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  setPaneTitle: (paneId, title) =>
    set(s => {
      const t = title.trim()
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, title: t || undefined })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  setPaneColor: (paneId, color) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, color: color ?? undefined })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  // Toggle worktree isolation for a pane. Turning it off clears the cached
  // path/branch so the next spawn re-resolves (or falls back to the root); the
  // worktree itself is left on disk to be removed explicitly.
  setPaneWorktree: (paneId, enabled) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({
        ...l,
        worktree: enabled,
        ...(enabled ? {} : { worktreePath: null, worktreeBranch: null }),
      })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  // Store a user-chosen worktree name. Trimmed; empty clears it (falls back to
  // the pane title). Takes effect the next time a worktree is created.
  setPaneWorktreeName: (paneId, name) =>
    set(s => {
      const n = name?.trim()
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, worktreeName: n || undefined })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  setPaneWorktreeInfo: (paneId, info) =>
    set(s => {
      const updated = makeRoot(updateLeaf(s.rootPane, paneId, l => ({
        ...l,
        worktreePath: info?.path ?? null,
        worktreeBranch: info?.branch ?? null,
      })))
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    }),

  splitPane: (paneId, direction) => {
    set(s => {
      const result = findParent(s.rootPane, paneId)
      if (!result) return s
      const { parent, index } = result
      const existingLeaf = parent.children[index] as PaneLeaf
      const newGroup: PaneGroup = {
        type: 'group', id: uuidv4(), direction,
        children: [existingLeaf, newLeaf()]
      }
      const newChildren = [...parent.children]
      newChildren[index] = newGroup
      const updated = replaceNode(s.rootPane, parent.id, { ...parent, children: newChildren }) as PaneGroup
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    })
  },

  addPane: (agentId, taskId) => {
    set(s => {
      const root = s.rootPane
      if (countLeaves(root) >= 16) return s
      const resolvedAgentId = agentId ?? s.defaultAgentId ?? null
      const leaf = newLeaf(resolvedAgentId, taskId)
      if (resolvedAgentId) leaf.pendingAutoSpawn = true
      const updated: PaneGroup = { ...root, children: [...root.children, leaf] }
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    })
  },

  clearPendingAutoSpawn: (paneId) =>
    set(s => ({ rootPane: makeRoot(updateLeaf(s.rootPane, paneId, l => ({ ...l, pendingAutoSpawn: false, resume: false }))) })),

  closePane: (paneId) => {
    set(s => {
      const result = findParent(s.rootPane, paneId)
      if (!result) return s
      // The pane is being destroyed (not just unmounted for a workspace switch),
      // so kill its PTY — otherwise the node-pty process leaks in the main process
      // and keeps streaming output / running a file watcher until app quit. Silent
      // so no pty:exit fires for the pane we're removing (no respawn/exit handler).
      window.swarmmind.ptyKill(paneId, true).catch(() => {})
      const { parent } = result
      const newChildren = parent.children.filter(c => c.id !== paneId)
      const updatedParent = { ...parent, children: newChildren }
      let updated = replaceNode(s.rootPane, parent.id, updatedParent) as PaneGroup
      updated = makeRoot(pruneGroup(updated))
      saveLayout(JSON.stringify(updated))
      const attention = { ...s.paneAttention }
      delete attention[paneId]
      const paneTask = { ...s.paneTask }
      delete paneTask[paneId]
      const paneCost = { ...s.paneCost }
      delete paneCost[paneId]
      return {
        rootPane: updated,
        selectedPaneIds: s.selectedPaneIds.filter(id => id !== paneId),
        paneAttention: attention,
        notifications: s.notifications.filter(n => n.paneId !== paneId),
        paneTask,
        paneCost,
        cliLoops: s.cliLoops.filter(c => c.paneId !== paneId),
        leadPaneId: s.leadPaneId === paneId ? null : s.leadPaneId,
        orchestratorProposal: s.orchestratorProposal?.paneId === paneId ? null : s.orchestratorProposal,
      }
    })
  },

  toggleKanban: () => set(s => ({ kanbanOpen: !s.kanbanOpen })),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  // The skills panel and the preview browser share the right edge, so opening
  // one closes the other (they can't be shown side by side).
  toggleMemoryPanel: () => set(s => ({ memoryPanelOpen: !s.memoryPanelOpen, previewPanelOpen: false })),
  togglePreviewPanel: () => set(s => ({ previewPanelOpen: !s.previewPanelOpen, memoryPanelOpen: false })),
  setPreviewUrl: (url) => set({ previewUrl: url }),
  openSetupModal: () => set({ setupModalOpen: true }),
  closeSetupModal: () => set({ setupModalOpen: false }),
  toggleFilePanel: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, filePanelOpen: !s.filePanelOpen })),
  openSettings: (agentId) => set({ settingsOpen: true, settingsAgentId: agentId ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsAgentId: null }),
  setActiveTask: (id) => set({ activeTaskId: id }),
  setShellStyle: (s) => set({ shellStyle: s }),

  setActivePaneId: (id) => set({ activePaneId: id }),

  togglePaneSelected: (paneId) =>
    set(s => ({
      selectedPaneIds: s.selectedPaneIds.includes(paneId)
        ? s.selectedPaneIds.filter(id => id !== paneId)
        : [...s.selectedPaneIds, paneId],
    })),

  clearPaneSelection: () => set({ selectedPaneIds: [] }),

  toggleBroadcastBar: () => set(s => ({ broadcastBarOpen: !s.broadcastBarOpen })),

  getLeafIds: () => {
    const ids: string[] = []
    const walk = (node: PaneNode) => {
      if (node.type === 'leaf') ids.push(node.id)
      else node.children.forEach(walk)
    }
    walk(get().rootPane)
    return ids
  },

  setPaneAttention: (paneId, state) =>
    set(s => {
      const next = { ...s.paneAttention }
      if (state === null) delete next[paneId]
      else next[paneId] = state
      return { paneAttention: next }
    }),

  // Record a "waiting for input" event for a pane. Deduped: if the pane already
  // has an unread notification we just refresh it (bump timestamp, move to top)
  // rather than pile up duplicates while the user hasn't looked yet.
  addPaneNotification: (paneId) =>
    set(s => {
      const leaf = findLeafById(s.rootPane, paneId)
      if (!leaf) return s
      // The user is already focused on this pane (they selected it) — they can
      // see it's waiting, so don't keep notifying for it cycle after cycle.
      if (s.activePaneId === paneId) return s
      const existing = s.notifications.find(n => n.paneId === paneId && !n.read)
      const entry: AppNotification = {
        id: existing?.id ?? uuidv4(),
        paneId,
        agentId: leaf.agentId,
        paneTitle: leaf.title,
        timestamp: Date.now(),
        read: false,
      }
      const rest = s.notifications.filter(n => n.id !== entry.id)
      return { notifications: [entry, ...rest] }
    }),

  markNotificationRead: (id) =>
    set(s => ({ notifications: s.notifications.map(n => (n.id === id ? { ...n, read: true } : n)) })),

  markPaneNotificationsRead: (paneId) =>
    set(s => ({ notifications: s.notifications.map(n => (n.paneId === paneId ? { ...n, read: true } : n)) })),

  markAllNotificationsRead: () =>
    set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })) })),

  deleteNotification: (id) =>
    set(s => ({ notifications: s.notifications.filter(n => n.id !== id) })),

  clearNotifications: () => set({ notifications: [] }),

  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleBoard: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, boardOpen: !s.boardOpen })),
  toggleComposer: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, composerOpen: !s.composerOpen })),
  openComposerWith: (seed) => set({ ...ALL_OVERLAYS_CLOSED, composerOpen: true, composerSeed: seed }),
  clearComposerSeed: () => set({ composerSeed: null }),
  toggleGraph: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, graphOpen: !s.graphOpen })),
  toggleReview: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, reviewOpen: !s.reviewOpen })),
  toggleTimeline: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, timelineOpen: !s.timelineOpen })),
  // Opening the Changes panel acknowledges current contention (clears the dot).
  toggleChanges: () => set(s => ({
    ...ALL_OVERLAYS_CLOSED,
    changesOpen: !s.changesOpen,
    contendedPaths: !s.changesOpen ? [] : s.contendedPaths,
  })),
  toggleCheckpoints: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, checkpointsOpen: !s.checkpointsOpen })),
  toggleBenchmarks: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, benchmarksOpen: !s.benchmarksOpen })),
  toggleSwarmAgent: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, swarmAgentOpen: !s.swarmAgentOpen })),
  addContendedPath: (path) =>
    set(s => (s.contendedPaths.includes(path) ? s : { contendedPaths: [...s.contendedPaths, path].slice(-50) })),
  updatePaneCost: (paneId, usd, tokens) =>
    set(s => ({ paneCost: { ...s.paneCost, [paneId]: { usd, tokens } } })),
  showTerminals: () => set({ ...ALL_OVERLAYS_CLOSED }),

  // ── Orchestration ─────────────────────────────────────────────────────────
  toggleOrchestratorBar: () => set(s => ({ orchestratorBarOpen: !s.orchestratorBarOpen })),

  setOrchestrationMode: (mode) =>
    set(s => {
      // Turning the conductor off clears any in-flight proposal so it doesn't
      // linger, but keeps the lead/goal/log so the user can resume.
      if (mode === 'off') return { orchestrationMode: mode, orchestratorProposal: null }
      return { orchestrationMode: mode }
    }),

  setLeadPaneId: (id) => set({ leadPaneId: id }),
  setOrchestratorGoal: (goal) => set({ orchestratorGoal: goal }),
  setOrchestratorPhase: (phase) => set({ orchestratorPhase: phase }),

  setPaneTask: (paneId, taskId) =>
    set(s => {
      const next = { ...s.paneTask }
      if (taskId === null) delete next[paneId]
      else next[paneId] = taskId
      return { paneTask: next }
    }),

  setOrchestratorProposal: (p) => set({ orchestratorProposal: p }),

  pushOrchestratorLog: (text) =>
    set(s => ({
      orchestratorLog: [{ id: uuidv4(), ts: Date.now(), text }, ...s.orchestratorLog].slice(0, 100),
    })),

  clearOrchestratorLog: () => set({ orchestratorLog: [] }),

  // Begin a goal-driven run: phase → 'running'. The conductor hook reacts by
  // injecting the decomposition prompt into the lead pane. Plain queue dispatch
  // (no goal) doesn't need this — it runs whenever the mode is not 'off'.
  startOrchestration: () => set({ orchestratorPhase: 'running' }),

  // Reset a run without changing the mode: drop the phase, any pending proposal,
  // and the per-pane task assignments.
  stopOrchestration: () => set({ orchestratorPhase: 'idle', orchestratorProposal: null, paneTask: {} }),

  // ── Loops ──────────────────────────────────────────────────────────────────
  toggleLoops: () => set(s => ({ ...ALL_OVERLAYS_CLOSED, loopsOpen: !s.loopsOpen })),

  addLoop: (input) => {
    const now = Date.now()
    const loop: SwarmLoop = {
      id: uuidv4(),
      name: input.name.trim() || 'Loop',
      description: input.description.trim(),
      prompt: input.prompt,
      // Clamp to a sane floor so a typo can't hammer a pane every tick.
      intervalSec: Math.max(5, Math.round(input.intervalSec) || 60),
      paneId: input.paneId,
      agentId: input.agentId,
      enabled: input.enabled ?? true,
      runCount: 0,
      lastRunAt: null,
      // Enabled loops fire on the next runner tick for immediate feedback.
      nextRunAt: (input.enabled ?? true) ? now : null,
      createdAt: now,
    }
    set(s => ({ loops: [loop, ...s.loops] }))
    return loop
  },

  updateLoop: (id, patch) =>
    set(s => ({
      loops: s.loops.map(l => {
        if (l.id !== id) return l
        const next = { ...l, ...patch }
        if (patch.intervalSec !== undefined) next.intervalSec = Math.max(5, Math.round(patch.intervalSec) || l.intervalSec)
        if (patch.name !== undefined) next.name = patch.name.trim() || l.name
        return next
      }),
    })),

  removeLoop: (id) => set(s => ({ loops: s.loops.filter(l => l.id !== id) })),

  setLoopEnabled: (id, enabled) =>
    set(s => ({
      loops: s.loops.map(l =>
        l.id === id
          // Re-enabling schedules the next run for the upcoming tick; pausing
          // clears the countdown.
          ? { ...l, enabled, nextRunAt: enabled ? Date.now() : null }
          : l
      ),
    })),

  markLoopRun: (id, at) =>
    set(s => ({
      loops: s.loops.map(l =>
        l.id === id
          ? { ...l, lastRunAt: at, nextRunAt: at + l.intervalSec * 1000, runCount: l.runCount + 1 }
          : l
      ),
    })),

  // Push the next attempt forward without counting it as a run — used when the
  // target pane isn't running yet, so the loop quietly retries next interval.
  deferLoop: (id, at) =>
    set(s => ({
      loops: s.loops.map(l => (l.id === id ? { ...l, nextRunAt: at + l.intervalSec * 1000 } : l)),
    })),

  setLoops: (loops) => set({ loops }),

  // Record a CLI-detected loop for a pane. A pane runs one loop at a time, so a
  // fresh `/loop` replaces any prior detection for that pane.
  addCliLoop: (paneId, command, interval) =>
    set(s => ({
      cliLoops: [
        { id: uuidv4(), paneId, command, interval, detectedAt: Date.now() },
        ...s.cliLoops.filter(c => c.paneId !== paneId),
      ],
    })),

  removeCliLoop: (id) => set(s => ({ cliLoops: s.cliLoops.filter(c => c.id !== id) })),

  clearPaneCliLoops: (paneId) => set(s => ({ cliLoops: s.cliLoops.filter(c => c.paneId !== paneId) })),

  setDefaultAgentId: (id) => {
    set({ defaultAgentId: id })
    window.swarmmind.setAppSetting('defaultAgentId', id ?? '').catch(() => {})
  },

  setTerminalFontSize: (n) => {
    const clamped = Math.min(24, Math.max(9, Math.round(n) || 13))
    set({ terminalFontSize: clamped })
    window.swarmmind.setAppSetting('terminalFontSize', String(clamped)).catch(() => {})
  },

  setTerminalCursorBlink: (b) => {
    set({ terminalCursorBlink: b })
    window.swarmmind.setAppSetting('terminalCursorBlink', b ? '1' : '0').catch(() => {})
  },

  setCloseToTray: (b) => {
    set({ closeToTray: b })
    window.swarmmind.setAppSetting('closeToTray', b ? '1' : '0').catch(() => {})
  },

  setLanguage: (lang) => {
    set({ language: lang })
    window.swarmmind.setAppSetting('language', lang).catch(() => {})
  },

  setVoiceModel: (m) => {
    set({ voiceModel: m })
    window.swarmmind.setAppSetting('voiceModel', m).catch(() => {})
  },

  setVoicePreload: (b) => {
    set({ voicePreload: b })
    window.swarmmind.setAppSetting('voicePreload', b ? '1' : '0').catch(() => {})
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  // Re-apply CSS variables from the current store state and bump the version so
  // the terminal (which can't read CSS vars) re-syncs its colours/font.
  setThemePreset: (p) => {
    set({ themePreset: p })
    window.swarmmind.setAppSetting('themePreset', p).catch(() => {})
    reapplyAppearance(get, set)
  },
  setAccentColor: (hex) => {
    set({ accentColor: hex })
    window.swarmmind.setAppSetting('accentColor', hex ?? '').catch(() => {})
    reapplyAppearance(get, set)
  },
  setUiDensity: (d) => {
    set({ uiDensity: d })
    window.swarmmind.setAppSetting('uiDensity', d).catch(() => {})
    reapplyAppearance(get, set)
  },
  setUiFont: (f) => {
    set({ uiFont: f })
    window.swarmmind.setAppSetting('uiFont', f).catch(() => {})
    reapplyAppearance(get, set)
  },
  setMonoFont: (f) => {
    set({ monoFont: f })
    window.swarmmind.setAppSetting('monoFont', f).catch(() => {})
    reapplyAppearance(get, set)
  },
  setEditorFontSize: (n) => {
    const size = clampEditorFontSize(n)
    set({ editorFontSize: size })
    window.swarmmind.setAppSetting('editorFontSize', String(size)).catch(() => {})
    reapplyAppearance(get, set)
  },

  setGhostTextEnabled: (b) => {
    set({ ghostTextEnabled: b })
    window.swarmmind.setAppSetting('editorGhostText', b ? '1' : '0').catch(() => {})
  },

  addSnippet: (name, body, lang) => {
    const snippet: Snippet = { id: uuidv4(), name: name.trim() || 'Snippet', body, ...(lang ? { lang } : {}) }
    const next = addSnippetTo(get().snippets, snippet)
    set({ snippets: next })
    window.swarmmind.setAppSetting('editorSnippets', JSON.stringify(next)).catch(() => {})
  },
  removeSnippet: (id) => {
    const next = removeSnippetFrom(get().snippets, id)
    set({ snippets: next })
    window.swarmmind.setAppSetting('editorSnippets', JSON.stringify(next)).catch(() => {})
  },

  // Set values from persisted settings at startup without re-persisting them,
  // then apply once.
  hydrateAppearance: (a) => {
    set(s => ({
      themePreset: a.themePreset ?? s.themePreset,
      accentColor: a.accentColor !== undefined ? a.accentColor : s.accentColor,
      uiDensity: a.uiDensity ?? s.uiDensity,
      uiFont: a.uiFont ?? s.uiFont,
      monoFont: a.monoFont ?? s.monoFont,
      editorFontSize: a.editorFontSize ?? s.editorFontSize,
    }))
    reapplyAppearance(get, set)
  },

  // ── Keybindings ──────────────────────────────────────────────────────────
  setKeybinding: (id, keys) =>
    set(s => {
      const next = { ...s.keybindings, [id]: keys }
      window.swarmmind.setAppSetting('keybindings', JSON.stringify(next)).catch(() => {})
      return { keybindings: next }
    }),

  resetKeybinding: (id) =>
    set(s => {
      const next = { ...s.keybindings }
      delete next[id]
      window.swarmmind.setAppSetting('keybindings', JSON.stringify(next)).catch(() => {})
      return { keybindings: next }
    }),

  hydrateKeybindings: (map) => set({ keybindings: map }),

  loadFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as PaneGroup
      set({ rootPane: sanitizeLoadedLayout(parsed) as PaneGroup })
    } catch { /* ignore */ }
  },

  swapPanes: (idA, idB) => {
    set(s => {
      if (idA === idB) return s
      function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
        if (node.type === 'leaf') return node.id === id ? node : null
        for (const c of node.children) { const f = findLeaf(c, id); if (f) return f }
        return null
      }
      const a = findLeaf(s.rootPane, idA)
      const b = findLeaf(s.rootPane, idB)
      if (!a || !b) return s
      const TEMP = '__swap__' + idA
      let updated = replaceNode(s.rootPane, idA, { ...a, id: TEMP }) as PaneGroup
      updated = replaceNode(updated, idB, { ...a }) as PaneGroup
      updated = replaceNode(updated, TEMP, { ...b }) as PaneGroup
      saveLayout(JSON.stringify(updated))
      return { rootPane: updated }
    })
  },

  resetLayout: () => {
    const root: PaneGroup = {
      type: 'group',
      id: uuidv4(),
      direction: 'horizontal',
      children: [newLeaf()]
    }
    saveLayout(JSON.stringify(root))
    set({ rootPane: root })
  },

  toJson: () => JSON.stringify(get().rootPane)
}))
