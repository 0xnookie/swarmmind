import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { getCurrentRootPath } from './workspace'

// Real Claude Code "Agent Skills" live as folders under a project's
// `.claude/skills/<slug>/SKILL.md`. Each SKILL.md has YAML frontmatter
// (`name`, `description`) that Claude Code reads to decide when to auto-invoke
// the skill, followed by a markdown body of instructions. This module reads and
// writes those files for the active workspace — distinct from the prompt-snippet
// "skills" stored in app.db.

export interface AgentSkillInfo {
  slug: string         // directory name under .claude/skills
  name: string         // frontmatter `name` (defaults to slug)
  description: string  // frontmatter `description`
  body: string         // markdown instructions (everything after frontmatter)
  path: string         // absolute SKILL.md path
  updatedAt: number
}

function skillsRoot(rootPath?: string | null): string | null {
  const r = rootPath || getCurrentRootPath()
  if (!r) return null
  return join(r, '.claude', 'skills')
}

// Claude Code skill names: lowercase, digits, hyphens; max 64 chars.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill'
}

// Reject anything that could escape the skills directory.
function safeSlug(slug: string): string | null {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null
  return slug
}

// Minimal frontmatter parser: pulls `name`/`description` from a leading
// `---\n…\n---` block and returns the remaining markdown as the body.
function parseSkillMd(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { body: raw.trim() }
  const front = m[1]
  const body = m[2].trim()
  const out: { name?: string; description?: string; body: string } = { body }
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let val = kv[2].trim()
    // Double-quoted values are written via JSON.stringify (buildSkillMd), so
    // JSON.parse is the exact inverse and correctly unescapes inner quotes.
    // Single-quoted values are taken literally minus the wrapping quotes.
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      try { val = JSON.parse(val) } catch { val = val.slice(1, -1) }
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1)
    }
    if (key === 'name') out.name = val
    else if (key === 'description') out.description = val
  }
  return out
}

// Quote a frontmatter scalar only when YAML would otherwise misread it.
function yamlScalar(s: string): string {
  const v = s.replace(/\r?\n/g, ' ').trim()
  if (v === '' || /[:#"'\[\]{}|>*&!%@`]/.test(v) || /^\s|\s$/.test(v)) {
    return JSON.stringify(v) // double-quoted, escapes inner quotes
  }
  return v
}

function buildSkillMd(name: string, description: string, body: string): string {
  return `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n\n${body.trim()}\n`
}

export function registerAgentSkillHandlers(): void {
  // List Agent Skills discovered in the workspace's .claude/skills.
  ipcMain.handle('agentSkill:list', (_e, rootPath?: string): AgentSkillInfo[] => {
    try {
      const dir = skillsRoot(rootPath)
      if (!dir || !existsSync(dir)) return []
      const out: AgentSkillInfo[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = join(dir, entry.name, 'SKILL.md')
        if (!existsSync(file)) continue
        try {
          const st = statSync(file)
          const parsed = parseSkillMd(readFileSync(file, 'utf-8'))
          out.push({
            slug: entry.name,
            name: parsed.name || entry.name,
            description: parsed.description || '',
            body: parsed.body,
            path: file,
            updatedAt: st.mtimeMs,
          })
        } catch { /* skip unreadable skill */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  })

  // Create or overwrite a skill. When `slug` is omitted it is derived from name.
  // Returns the written slug, or null if no workspace is open.
  ipcMain.handle('agentSkill:write', (_e, args: { rootPath?: string; slug?: string; name: string; description: string; body: string }): string | null => {
    const dir = skillsRoot(args.rootPath)
    if (!dir) return null
    const slug = safeSlug(args.slug || slugify(args.name))
    if (!slug) return null
    const skillDir = join(dir, slug)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), buildSkillMd(args.name, args.description, args.body), 'utf-8')
    return slug
  })

  // Delete a skill folder (recursively). Guarded against path traversal.
  ipcMain.handle('agentSkill:delete', (_e, rootPath: string | undefined, slug: string): boolean => {
    try {
      const dir = skillsRoot(rootPath)
      const safe = safeSlug(slug)
      if (!dir || !safe) return false
      const skillDir = join(dir, safe)
      if (!existsSync(skillDir)) return false
      rmSync(skillDir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  })
}
