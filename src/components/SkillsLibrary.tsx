import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspaceStore } from '../store/workspace'

// ─── Icon helpers ───────────────────────────────────────────────────────────
interface IconProps { size?: number; stroke?: number; color?: string }

function Svg({ size = 16, stroke = 1.75, color, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const IconShield     = (p: IconProps) => <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6z"/></Svg>
const IconTrendingUp = (p: IconProps) => <Svg {...p}><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></Svg>
const IconGitBranch  = (p: IconProps) => <Svg {...p}><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-4 4-6 4h-2"/></Svg>
const IconBookOpen   = (p: IconProps) => <Svg {...p}><path d="M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z"/></Svg>
const IconBrain      = (p: IconProps) => <Svg {...p}><path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.5A3 3 0 0 0 6 17a3 3 0 0 0 3 3 3 3 0 0 0 3-3V3z"/><path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5.5A3 3 0 0 1 18 17a3 3 0 0 1-3 3 3 3 0 0 1-3-3V3z"/></Svg>
const IconBox        = (p: IconProps) => <Svg {...p}><path d="m21 16-9 5-9-5V8l9-5 9 5z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></Svg>
const IconSearch     = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Svg>
const IconPlus       = (p: IconProps) => <Svg {...p}><path d="M5 12h14"/><path d="M12 5v14"/></Svg>
const IconX          = (p: IconProps) => <Svg {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Svg>
const IconLock       = (p: IconProps) => <Svg {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></Svg>
const IconGrip       = (p: IconProps) => <Svg {...p}><circle cx="9" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="15" cy="18" r="1.2"/></Svg>
const IconCheck      = (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5"/></Svg>
const IconPlay       = (p: IconProps) => <Svg {...p}><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></Svg>
const IconPencil     = (p: IconProps) => <Svg {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></Svg>
const IconCopy       = (p: IconProps) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></Svg>
const IconDuplicate  = (p: IconProps) => <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/><path d="M14 11v4"/><path d="M12 13h4"/></Svg>
const IconTrash      = (p: IconProps) => <Svg {...p}><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></Svg>
const IconCode2      = (p: IconProps) => <Svg {...p}><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></Svg>
const IconFileText   = (p: IconProps) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></Svg>
const IconArrowUpRt  = (p: IconProps) => <Svg {...p}><path d="M7 17 17 7"/><path d="M7 7h10v10"/></Svg>
const IconRefresh    = (p: IconProps) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></Svg>

// ─── Category metadata ────────────────────────────────────────────────────────
// Single source of truth for label + colour + icon, keyed by the `category` value
// stored on a skill. Covers both the seeded built-in categories
// (review/testing/docs/refactor/debug) and the user-selectable set.
interface CatMeta { label: string; color: string; Icon: (p: IconProps) => JSX.Element }
const CATEGORY_META: Record<string, CatMeta> = {
  review:    { label: 'REVIEW',    color: '#ef4444', Icon: IconShield },
  testing:   { label: 'TESTING',   color: '#10b981', Icon: IconCheck },
  docs:      { label: 'DOCS',      color: '#3b82f6', Icon: IconBookOpen },
  refactor:  { label: 'REFACTOR',  color: '#f59e0b', Icon: IconGitBranch },
  debug:     { label: 'DEBUG',     color: '#a78bfa', Icon: IconBrain },
  security:  { label: 'SECURITY',  color: '#10b981', Icon: IconShield },
  growth:    { label: 'GROWTH',    color: '#14b8a6', Icon: IconTrendingUp },
  workflow:  { label: 'WORKFLOW',  color: '#f59e0b', Icon: IconGitBranch },
  memory:    { label: 'MEMORY',    color: '#a855f7', Icon: IconBrain },
  knowledge: { label: 'KNOWLEDGE', color: '#3b82f6', Icon: IconBookOpen },
  general:   { label: 'GENERAL',   color: '#6b7280', Icon: IconBox },
}
const DEFAULT_CAT: CatMeta = { label: 'GENERAL', color: '#6b7280', Icon: IconBox }
function catMeta(category: string): CatMeta { return CATEGORY_META[category] || DEFAULT_CAT }

// Categories offered in the create/edit form (order = display order).
const CATEGORIES = ['general', 'review', 'testing', 'docs', 'refactor', 'debug', 'security', 'workflow', 'memory', 'knowledge']

// ─── Variable token parsing ─────────────────────────────────────────────────
const VAR_RE = /\{\{\s*([a-z_]+)(?::([^}]*))?\s*\}\}/gi
// Distinct token labels in a prompt, e.g. ["selection", "memory:plan", "input:focus"].
function promptTokens(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  VAR_RE.lastIndex = 0
  while ((m = VAR_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase()
    const label = m[2]?.trim() ? `${name}:${m[2].trim()}` : name
    if (!seen.has(label)) { seen.add(label); out.push(label) }
  }
  return out
}

// ─── Built-in heuristic ─────────────────────────────────────────────────────
function isBuiltin(skill: Skill): boolean {
  const id = parseInt(skill.id, 10)
  if (!isNaN(id) && id >= 1 && id <= 6) return true
  if (skill.name.toLowerCase().startsWith('swarm')) return true
  return false
}

// ─── Small badge ────────────────────────────────────────────────────────────
function SmallBadge({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      height: 18, padding: '0 7px',
      borderRadius: 9,
      background: accent ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
      color: accent ? 'var(--accent)' : 'var(--text-muted)',
      fontSize: 11, fontWeight: 500,
      lineHeight: 1,
      flexShrink: 0,
    }}>
      {children}
    </span>
  )
}

// ─── Hover action button ──────────────────────────────────────────────────────
function ActionBtn({ title, danger, onClick, children }: {
  title: string; danger?: boolean; onClick: (e: React.MouseEvent) => void; children: React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 24, height: 24, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 5, border: 'none',
        background: hovered ? (danger ? 'color-mix(in srgb, #ef4444 22%, transparent)' : 'var(--bg-elevated-2, var(--bg-elevated))') : 'transparent',
        color: hovered ? (danger ? '#ef4444' : 'var(--text-primary)') : 'var(--text-muted)',
        cursor: 'pointer', padding: 0,
        transition: 'background 120ms, color 120ms',
      }}
    >
      {children}
    </button>
  )
}

// ─── Skill card ─────────────────────────────────────────────────────────────
interface SkillCardProps {
  skill: Skill
  builtin: boolean
  expanded: boolean
  reorderable: boolean
  dragOver: boolean
  onToggleExpand: () => void
  onRun: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onCopy: () => void
  onPromote: () => void
  onReorderDragStart: () => void
  onReorderDragOver: () => void
  onReorderDrop: () => void
  onReorderDragEnd: () => void
}

function SkillCard(props: SkillCardProps) {
  const { skill, builtin, expanded, reorderable, dragOver, onToggleExpand, onRun, onEdit, onDuplicate, onDelete, onCopy, onPromote } = props
  const [hovered, setHovered] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  const meta = catMeta(skill.category)
  const Icon = meta.Icon
  const tokens = promptTokens(skill.prompt_text)

  const handleDragStart = (e: React.DragEvent) => {
    // Two payloads: terminals read application/skill to paste; the list reads the
    // reorder type to resequence. dataTransfer can carry both simultaneously.
    e.dataTransfer.setData('application/skill', JSON.stringify({
      id: skill.id, name: skill.name, promptText: skill.prompt_text,
    }))
    if (reorderable) {
      e.dataTransfer.setData('application/x-skill-reorder', skill.id)
      props.onReorderDragStart()
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={props.onReorderDragEnd}
      onDragOver={(e) => {
        if (reorderable && e.dataTransfer.types.includes('application/x-skill-reorder')) {
          e.preventDefault()
          props.onReorderDragOver()
        }
      }}
      onDrop={(e) => {
        if (reorderable && e.dataTransfer.types.includes('application/x-skill-reorder')) {
          e.preventDefault()
          props.onReorderDrop()
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setGrabbing(false) }}
      onMouseDown={() => setGrabbing(true)}
      onMouseUp={() => setGrabbing(false)}
      style={{
        padding: 12,
        borderRadius: 8,
        background: hovered || expanded ? 'var(--bg-elevated)' : 'transparent',
        borderTop: dragOver ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: grabbing ? 'grabbing' : (hovered ? 'grab' : 'default'),
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        transition: 'background 150ms ease-out',
      }}
    >
      {/* Grip dots */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        marginLeft: -4, color: 'var(--text-dim)', paddingTop: 6,
        opacity: hovered ? 1 : 0, transition: 'opacity 150ms ease-out',
      }}>
        <IconGrip size={12} stroke={1.5} />
      </div>

      {/* Icon box (category-coloured) */}
      <div style={{
        width: 32, height: 32, flexShrink: 0, borderRadius: 6,
        background: `color-mix(in srgb, ${meta.color} 16%, var(--bg-elevated))`,
        color: meta.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Name + action row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 24 }}>
          <span
            onClick={onToggleExpand}
            style={{
              fontSize: 14, fontWeight: 500, color: 'var(--text-primary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              cursor: 'pointer', flexShrink: 1,
            }}
          >
            {skill.name}
          </span>
          {builtin && (
            <span style={{ color: 'var(--text-dim)', flexShrink: 0 }} title="Built-in — duplicate to customize">
              <IconLock size={12} stroke={1.5} />
            </span>
          )}
          <div style={{ flex: 1 }} />
          {/* Actions — visible on hover/expand */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0,
            opacity: hovered || expanded ? 1 : 0,
            pointerEvents: hovered || expanded ? 'auto' : 'none',
            transition: 'opacity 120ms',
          }}>
            <ActionBtn title="Run in active terminal" onClick={(e) => { e.stopPropagation(); onRun() }}><IconPlay size={13} /></ActionBtn>
            <ActionBtn title="Save as Agent Skill (.claude/skills)" onClick={(e) => { e.stopPropagation(); onPromote() }}><IconArrowUpRt size={13} /></ActionBtn>
            <ActionBtn title="Copy prompt" onClick={(e) => { e.stopPropagation(); onCopy() }}><IconCopy size={13} /></ActionBtn>
            <ActionBtn title="Duplicate" onClick={(e) => { e.stopPropagation(); onDuplicate() }}><IconDuplicate size={13} /></ActionBtn>
            {!builtin && <ActionBtn title="Edit" onClick={(e) => { e.stopPropagation(); onEdit() }}><IconPencil size={13} /></ActionBtn>}
            {!builtin && <ActionBtn title="Delete" danger onClick={(e) => { e.stopPropagation(); onDelete() }}><IconTrash size={13} /></ActionBtn>}
          </div>
        </div>

        {/* Description — clamp to 2 lines unless expanded */}
        {skill.description && (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45,
            ...(expanded ? {} : {
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }),
          } as React.CSSProperties}>
            {skill.description}
          </div>
        )}

        {/* Tag row: category + variable tokens */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 5px',
            borderRadius: 3, background: `color-mix(in srgb, ${meta.color} 20%, transparent)`,
            color: meta.color, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            {meta.label}
          </span>
          {tokens.map(t => (
            <span key={t} title="Resolved at run time" style={{
              display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 5px',
              borderRadius: 3, background: 'var(--bg-elevated-2, var(--bg-elevated))',
              color: 'var(--accent)', fontSize: 10, fontWeight: 500, fontFamily: 'var(--font-mono)',
            }}>
              {`{{${t}}}`}
            </span>
          ))}
        </div>

        {/* Expanded preview */}
        {expanded && (
          <pre style={{
            margin: '6px 0 2px', padding: 10,
            background: 'var(--bg-input)', borderRadius: 6,
            color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.5,
            fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 220, overflowY: 'auto',
          }}>
            {skill.prompt_text}
          </pre>
        )}
      </div>
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────
function Section({ title, tag, children }: { title: string; tag: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '0 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 8px' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {title}
        </span>
        <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4 }}>
          {tag}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {children}
      </div>
    </div>
  )
}

// ─── Create / edit form ───────────────────────────────────────────────────────
const PRESET_COLORS = ['#7c3aed', '#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#fb923c', '#a78bfa', '#f472b6']

interface SkillFormValues {
  name: string
  description: string
  promptText: string
  color: string
  category: string
}

function SkillForm({ initial, mode, onSave, onCancel }: {
  initial?: Partial<SkillFormValues>
  mode: 'create' | 'edit'
  onSave: (form: SkillFormValues) => Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<SkillFormValues>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    promptText: initial?.promptText ?? '',
    color: initial?.color ?? '#7c3aed',
    category: initial?.category ?? 'general',
  })
  const [saving, setSaving] = useState(false)
  const canSave = form.name.trim() && form.promptText.trim()

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 6,
    color: 'var(--text-primary)', padding: '5px 9px', fontSize: 12, outline: 'none',
    fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  }

  return (
    <div style={{
      margin: '0 8px 8px', padding: 12, background: 'var(--bg-elevated)', borderRadius: 8,
      border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <input style={inputStyle} placeholder="Skill name…" value={form.name} autoFocus
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      <input style={inputStyle} placeholder="Short description (optional)" value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
      <textarea
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)', resize: 'vertical', lineHeight: 1.5 }}
        placeholder="Prompt text to send to the terminal…"
        value={form.promptText}
        onChange={e => setForm(f => ({ ...f, promptText: e.target.value }))}
        rows={5}
      />
      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        Variables resolved at run time:{' '}
        <code style={{ color: 'var(--accent)' }}>{'{{selection}} {{output}} {{memory:key}} {{input:label}} {{cwd}} {{clipboard}} {{date}}'}</code>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          style={{ ...inputStyle, width: 'auto', flex: 1, cursor: 'pointer' }}
          value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
        >
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
              style={{
                width: 16, height: 16, borderRadius: '50%', background: c, border: 'none',
                cursor: 'pointer', padding: 0,
                outline: form.color === c ? `2px solid ${c}` : 'none', outlineOffset: 2,
              }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={!canSave || saving}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-fg)',
            padding: '5px 14px', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 12,
            fontWeight: 600, opacity: canSave ? 1 : 0.5,
          }}>
          {saving ? 'Saving…' : (mode === 'edit' ? 'Save' : 'Create')}
        </button>
        <button onClick={onCancel}
          style={{
            background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 6,
            color: 'var(--text-muted)', padding: '5px 12px', cursor: 'pointer', fontSize: 12,
          }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Prompt library (snippets stored in app.db) ──────────────────────────────
function PromptLibrary({ onPromote }: { onPromote: (skill: Skill) => void }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()

  const activePaneId = useWorkspaceStore(s => s.activePaneId)

  const refresh = useCallback(async () => {
    const list = await window.swarmmind.skillList()
    setSkills(list)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const showFlash = useCallback((msg: string) => {
    setFlash(msg)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2200)
  }, [])

  // ── Actions ──
  const runSkill = useCallback((skill: Skill) => {
    const paneId = useWorkspaceStore.getState().activePaneId
    if (!paneId) { showFlash('Click a terminal first, then Run'); return }
    window.dispatchEvent(new CustomEvent('swarmmind:run-skill', {
      detail: { paneId, promptText: skill.prompt_text, submit: true },
    }))
    showFlash(`Ran "${skill.name}"`)
  }, [showFlash])

  const copySkill = useCallback((skill: Skill) => {
    navigator.clipboard.writeText(skill.prompt_text).then(() => showFlash('Prompt copied')).catch(() => {})
  }, [showFlash])

  const duplicateSkill = useCallback(async (skill: Skill) => {
    await window.swarmmind.skillCreate(
      `${skill.name} copy`, skill.description, skill.prompt_text, skill.color,
      isBuiltin(skill) ? 'general' : skill.category,
    )
    await refresh()
    showFlash('Duplicated')
  }, [refresh, showFlash])

  const deleteSkill = useCallback(async (skill: Skill) => {
    if (!window.confirm(`Delete "${skill.name}"? This cannot be undone.`)) return
    await window.swarmmind.skillDelete(skill.id)
    if (expandedId === skill.id) setExpandedId(null)
    if (editingId === skill.id) setEditingId(null)
    await refresh()
  }, [refresh, expandedId, editingId])

  const handleCreate = async (form: SkillFormValues) => {
    await window.swarmmind.skillCreate(
      form.name.trim(), form.description.trim() || null, form.promptText, form.color, form.category,
    )
    setCreating(false)
    refresh()
  }

  const handleSaveEdit = async (id: string, form: SkillFormValues) => {
    await window.swarmmind.skillUpdate(
      id, form.name.trim(), form.description.trim() || null, form.promptText, form.color, form.category,
    )
    setEditingId(null)
    refresh()
  }

  // ── Filter ──
  const q = search.trim().toLowerCase()
  const filtered = q
    ? skills.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.prompt_text.toLowerCase().includes(q) ||
        catMeta(s.category).label.toLowerCase().includes(q)
      )
    : skills

  const builtins = filtered.filter(isBuiltin)
  const userSkills = filtered.filter(s => !isBuiltin(s))
  const totalCount = skills.length
  // Reorder only when the full, unfiltered list is shown — otherwise indices lie.
  const reorderable = !q

  // ── Reorder (user skills) ──
  const commitReorder = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    const allUser = skills.filter(s => !isBuiltin(s)).map(s => s.id)
    const from = allUser.indexOf(draggedId)
    const to = allUser.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...allUser]
    next.splice(from, 1)
    next.splice(to, 0, draggedId)
    const fullOrder = [...skills.filter(isBuiltin).map(s => s.id), ...next]
    const byId = new Map(skills.map(s => [s.id, s]))
    setSkills(fullOrder.map(id => byId.get(id)!).filter(Boolean))
    window.swarmmind.skillReorder(fullOrder).catch(() => {})
  }, [skills])

  const cardHandlers = (skill: Skill, builtin: boolean): SkillCardProps => ({
    skill, builtin,
    expanded: expandedId === skill.id,
    reorderable: reorderable && !builtin,
    dragOver: dragOverId === skill.id && draggingId !== null && draggingId !== skill.id,
    onToggleExpand: () => setExpandedId(id => id === skill.id ? null : skill.id),
    onRun: () => runSkill(skill),
    onEdit: () => { setEditingId(skill.id); setExpandedId(null) },
    onDuplicate: () => duplicateSkill(skill),
    onDelete: () => deleteSkill(skill),
    onCopy: () => copySkill(skill),
    onPromote: () => onPromote(skill),
    onReorderDragStart: () => setDraggingId(skill.id),
    onReorderDragOver: () => setDragOverId(skill.id),
    onReorderDrop: () => { if (draggingId) commitReorder(draggingId, skill.id); setDraggingId(null); setDragOverId(null) },
    onReorderDragEnd: () => { setDraggingId(null); setDragOverId(null) },
  })

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      position: 'relative', overflow: 'hidden',
    }}>

      {/* run-target hint */}
      <div style={{
        flexShrink: 0, padding: '6px 16px 0',
        fontSize: 10.5, color: activePaneId ? 'var(--success)' : 'var(--text-dim)',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <IconCheck size={11} stroke={2.25} />
        {activePaneId ? 'Run ▶ targets the active pane' : 'Click a terminal to set the run target'}
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>Library</span>
              <SmallBadge>{totalCount}</SmallBadge>
            </div>
            <div style={{ flex: 1 }} />
            <NewButton onClick={() => { setCreating(v => !v); setEditingId(null) }} />
          </div>

          {/* Search */}
          <div style={{
            position: 'relative', height: 32, background: 'var(--bg-input)',
            border: searchFocused ? '1px solid var(--accent)' : '1px solid transparent',
            borderRadius: 6, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
            transition: 'border-color 150ms ease-out',
          }}>
            <span style={{ color: 'var(--text-muted)', display: 'flex', flexShrink: 0 }}><IconSearch size={14} /></span>
            <input
              ref={searchRef} type="text" placeholder="Search skills & prompts" value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', minWidth: 0,
              }}
            />
            {search && (
              <button aria-label="Clear search" onClick={() => { setSearch(''); searchRef.current?.focus() }}
                style={{
                  width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                  borderRadius: 4, padding: 0, flexShrink: 0,
                }}>
                <IconX size={12} />
              </button>
            )}
          </div>

          {/* Subtitle */}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Drag onto a terminal to paste, or hit <span style={{ color: 'var(--accent)' }}>▶</span> to run in the active pane. Click a name to preview.
          </div>
        </div>

        {/* Inline create form */}
        {creating && <SkillForm mode="create" onSave={handleCreate} onCancel={() => setCreating(false)} />}

        {/* SwarmMind built-ins */}
        <Section title="SwarmMind" tag="Built-in">
          {builtins.length === 0
            ? <EmptyState />
            : builtins.map(s => <SkillCard key={s.id} {...cardHandlers(s, true)} />)}
        </Section>

        {/* User skills */}
        <Section title="Your Skills" tag="Custom">
          {userSkills.length === 0
            ? <EmptyState label={skills.some(s => !isBuiltin(s)) ? 'No matching skills' : 'No custom skills yet — hit New'} />
            : userSkills.map(s => (
                editingId === s.id
                  ? <SkillForm key={s.id} mode="edit"
                      initial={{ name: s.name, description: s.description ?? '', promptText: s.prompt_text, color: s.color, category: s.category }}
                      onSave={(form) => handleSaveEdit(s.id, form)}
                      onCancel={() => setEditingId(null)} />
                  : <SkillCard key={s.id} {...cardHandlers(s, false)} />
              ))}
        </Section>

        <div style={{ height: 16 }} />
      </div>

      {/* ── Flash toast ── */}
      {flash && (
        <div style={{
          position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated-2, var(--bg-elevated))', color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)', borderRadius: 8,
          padding: '7px 14px', fontSize: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
          pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 30,
        }}>
          {flash}
        </div>
      )}
    </div>
  )
}

// ─── New button (hover-stateful) ────────────────────────────────────────────
function NewButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px',
        fontSize: 12, color: hovered ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: hovered ? 'var(--bg-elevated)' : 'transparent', borderRadius: 6, border: 'none',
        cursor: 'pointer', transition: 'background 150ms ease-out, color 150ms ease-out',
      }}
    >
      <IconPlus size={14} />
      <span>New</span>
    </button>
  )
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ label = 'No matching skills' }: { label?: string }) {
  return (
    <div style={{ padding: '20px 12px', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>
      {label}
    </div>
  )
}

// ─── Agent Skills (real .claude/skills/*/SKILL.md) ───────────────────────────
interface AgentSkillFormValues { name: string; description: string; body: string }

function AgentSkillForm({ initial, mode, onSave, onCancel }: {
  initial?: Partial<AgentSkillFormValues>
  mode: 'create' | 'edit'
  onSave: (v: AgentSkillFormValues) => Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<AgentSkillFormValues>({
    name: initial?.name ?? '', description: initial?.description ?? '', body: initial?.body ?? '',
  })
  const [saving, setSaving] = useState(false)
  const canSave = form.name.trim() && form.description.trim() && form.body.trim()
  const slug = slugifyName(form.name)

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 6,
    color: 'var(--text-primary)', padding: '5px 9px', fontSize: 12, outline: 'none',
    fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  }

  return (
    <div style={{
      margin: '0 8px 8px', padding: 12, background: 'var(--bg-elevated)', borderRadius: 8,
      border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <input style={inputStyle} placeholder="Skill name (e.g. PDF Extractor)" value={form.name} autoFocus
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      {mode === 'create' && form.name.trim() && (
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          → .claude/skills/{slug}/SKILL.md
        </div>
      )}
      <textarea
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
        placeholder="description — when Claude should use this skill (the trigger). e.g. 'Use when extracting text or tables from PDF files.'"
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        rows={2}
      />
      <textarea
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)', resize: 'vertical', lineHeight: 1.5 }}
        placeholder="Instructions (SKILL.md body) — the steps Claude follows once the skill is invoked."
        value={form.body}
        onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
        rows={6}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleSave} disabled={!canSave || saving}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-fg)',
            padding: '5px 14px', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 12,
            fontWeight: 600, opacity: canSave ? 1 : 0.5,
          }}>
          {saving ? 'Saving…' : (mode === 'edit' ? 'Save' : 'Create')}
        </button>
        <button onClick={onCancel}
          style={{
            background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 6,
            color: 'var(--text-muted)', padding: '5px 12px', cursor: 'pointer', fontSize: 12,
          }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// Mirror of the main process slugify so the form can preview the target path.
function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function AgentSkillCard({ skill, expanded, onToggle, onEdit, onDelete, onCopyPath }: {
  skill: AgentSkillInfo
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onCopyPath: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: 12, borderRadius: 8,
        background: hovered || expanded ? 'var(--bg-elevated)' : 'transparent',
        display: 'flex', gap: 12, alignItems: 'flex-start',
        transition: 'background 150ms ease-out',
      }}
    >
      <div style={{
        width: 32, height: 32, flexShrink: 0, borderRadius: 6,
        background: 'color-mix(in srgb, var(--accent) 16%, var(--bg-elevated))', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <IconFileText size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 24 }}>
          <span onClick={onToggle} style={{
            fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1,
          }}>{skill.name}</span>
          <div style={{ flex: 1 }} />
          <div style={{
            display: 'flex', gap: 1, flexShrink: 0,
            opacity: hovered || expanded ? 1 : 0, pointerEvents: hovered || expanded ? 'auto' : 'none',
            transition: 'opacity 120ms',
          }}>
            <ActionBtn title="Copy path" onClick={(e) => { e.stopPropagation(); onCopyPath() }}><IconCopy size={13} /></ActionBtn>
            <ActionBtn title="Edit" onClick={(e) => { e.stopPropagation(); onEdit() }}><IconPencil size={13} /></ActionBtn>
            <ActionBtn title="Delete" danger onClick={(e) => { e.stopPropagation(); onDelete() }}><IconTrash size={13} /></ActionBtn>
          </div>
        </div>
        {skill.description && (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45,
            ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
          } as React.CSSProperties}>{skill.description}</div>
        )}
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>.claude/skills/{skill.slug}</span>
        {expanded && skill.body && (
          <pre style={{
            margin: '6px 0 2px', padding: 10, background: 'var(--bg-input)', borderRadius: 6,
            color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto',
          }}>{skill.body}</pre>
        )}
      </div>
    </div>
  )
}

function AgentSkillsPanel({ prefill, onPrefillConsumed }: {
  prefill: AgentSkillFormValues | null
  onPrefillConsumed: () => void
}) {
  const rootPath = useWorkspaceStore(s => s.workspace?.rootPath ?? null)
  const [list, setList] = useState<AgentSkillInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()

  const refresh = useCallback(async () => {
    if (!rootPath) { setList([]); return }
    setList(await window.swarmmind.agentSkillList(rootPath))
  }, [rootPath])

  useEffect(() => { refresh() }, [refresh])

  // Apply a prefill handed over from "Promote to Agent Skill".
  useEffect(() => {
    if (prefill) { setCreating(true); setEditingSlug(null) }
  }, [prefill])

  const showFlash = useCallback((msg: string) => {
    setFlash(msg); clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2200)
  }, [])

  const create = async (v: AgentSkillFormValues) => {
    await window.swarmmind.agentSkillWrite({ rootPath: rootPath ?? undefined, name: v.name.trim(), description: v.description.trim(), body: v.body })
    setCreating(false); onPrefillConsumed(); await refresh(); showFlash('Skill written')
  }
  const saveEdit = async (slug: string, v: AgentSkillFormValues) => {
    await window.swarmmind.agentSkillWrite({ rootPath: rootPath ?? undefined, slug, name: v.name.trim(), description: v.description.trim(), body: v.body })
    setEditingSlug(null); await refresh(); showFlash('Saved')
  }
  const del = async (skill: AgentSkillInfo) => {
    if (!window.confirm(`Delete Agent Skill "${skill.name}"?\nThis removes .claude/skills/${skill.slug}.`)) return
    await window.swarmmind.agentSkillDelete(rootPath ?? undefined, skill.slug)
    if (expandedSlug === skill.slug) setExpandedSlug(null)
    await refresh()
  }

  if (!rootPath) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', lineHeight: 1.6, maxWidth: 240 }}>
          Open a workspace to author Agent Skills. They are written to
          <code style={{ color: 'var(--text-muted)' }}> .claude/skills/</code> so Claude Code auto-discovers them.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>Agent Skills</span>
              <SmallBadge>{list.length}</SmallBadge>
            </div>
            <div style={{ flex: 1 }} />
            <ActionBtn title="Refresh" onClick={() => refresh()}><IconRefresh size={14} /></ActionBtn>
            <NewButton onClick={() => { setCreating(v => !v); setEditingSlug(null); onPrefillConsumed() }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Real Claude Code skills in this workspace. Claude auto-invokes them based on the description — no pasting needed.
          </div>
        </div>

        {creating && (
          <AgentSkillForm mode="create" initial={prefill ?? undefined} onSave={create}
            onCancel={() => { setCreating(false); onPrefillConsumed() }} />
        )}

        <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {list.length === 0 && !creating
            ? <EmptyState label="No Agent Skills yet — hit New" />
            : list.map(s => (
                editingSlug === s.slug
                  ? <AgentSkillForm key={s.slug} mode="edit"
                      initial={{ name: s.name, description: s.description, body: s.body }}
                      onSave={(v) => saveEdit(s.slug, v)} onCancel={() => setEditingSlug(null)} />
                  : <AgentSkillCard key={s.slug} skill={s}
                      expanded={expandedSlug === s.slug}
                      onToggle={() => setExpandedSlug(v => v === s.slug ? null : s.slug)}
                      onEdit={() => { setEditingSlug(s.slug); setExpandedSlug(null) }}
                      onDelete={() => del(s)}
                      onCopyPath={() => navigator.clipboard.writeText(s.path).then(() => showFlash('Path copied')).catch(() => {})} />
              ))}
        </div>
        <div style={{ height: 16 }} />
      </div>

      {flash && (
        <div style={{
          position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated-2, var(--bg-elevated))', color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '7px 14px', fontSize: 12,
          boxShadow: '0 6px 24px rgba(0,0,0,0.4)', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 30,
        }}>{flash}</div>
      )}
    </div>
  )
}

// ─── Tab host (root export) ───────────────────────────────────────────────────
export function SkillsLibrary() {
  const [tab, setTab] = useState<'prompts' | 'agent'>('prompts')
  const [agentPrefill, setAgentPrefill] = useState<AgentSkillFormValues | null>(null)

  const promote = useCallback((skill: Skill) => {
    setAgentPrefill({ name: skill.name, description: skill.description ?? '', body: skill.prompt_text })
    setTab('agent')
  }, [])

  const TabBtn = ({ id, label, Icon }: { id: 'prompts' | 'agent'; label: string; Icon: (p: IconProps) => JSX.Element }) => {
    const active = tab === id
    return (
      <button
        onClick={() => setTab(id)}
        style={{
          position: 'relative', height: 44, padding: '0 12px',
          display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent',
          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
          fontSize: 13, fontWeight: active ? 600 : 500, cursor: 'pointer',
        }}
      >
        <Icon size={15} />
        <span>{label}</span>
        {active && <div style={{ position: 'absolute', left: 8, right: 8, bottom: 0, height: 2, background: 'var(--accent)', borderRadius: '2px 2px 0 0' }} />}
      </button>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-panel)', borderLeft: '1px solid var(--border-subtle)', overflow: 'hidden',
    }}>
      <div style={{ flexShrink: 0, height: 44, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', padding: '0 6px' }}>
        <TabBtn id="prompts" label="Prompts" Icon={IconCode2} />
        <TabBtn id="agent" label="Agent Skills" Icon={IconFileText} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'prompts'
          ? <PromptLibrary onPromote={promote} />
          : <AgentSkillsPanel prefill={agentPrefill} onPrefillConsumed={() => setAgentPrefill(null)} />}
      </div>
    </div>
  )
}
